import { EventEmitter } from "node:events";
import { Timestamp } from "@bufbuild/protobuf";

import { CascadeStep, PermissionScope, toRunStatus, type ApprovalRequest, type StepNewEvent, type StepUpdateEvent, type TextDeltaEvent, type ThinkingDeltaEvent, type StatusChangeEvent } from "../vendor/antigravity-client/src/types.js";
import type { Cascade } from "../vendor/antigravity-client/src/cascade.js";
import type { Step, Trajectory } from "../vendor/antigravity-client/src/gen/exa/gemini_coder/proto/trajectory_pb.js";

import { formatRequestedModel, resolveRequestedModel, type RequestedModelChoice } from "./model.js";
import type { AutoApprovalSettings, BridgeEvent, BridgeMode, PendingApprovalSummary, SessionSnapshot } from "./types.js";

interface SessionOptions {
  id: string;
  mode: BridgeMode;
  workspacePath?: string;
  requestedModel?: string;
  title?: string;
  cascade: Cascade;
  getAutoApprovalSettings?: () => AutoApprovalSettings;
}

interface PendingApprovalRecord {
  summary: PendingApprovalSummary;
  request: ApprovalRequest;
}

interface StepTimingSummary {
  chatStartCreatedAt?: string;
  createdAt?: string;
  viewableAt?: string;
  finishedGeneratingAt?: string;
  lastCompletedChunkAt?: string;
  completedAt?: string;
  latestStatusTransitionAt?: string;
  statusTransitions: Array<{
    updatedStatus: number;
    timestamp: string | null;
  }>;
  sourceTimestamp?: string;
  latestTimestamp?: string;
}

const FALLBACK_POLL_INTERVAL_MS = 250;

export class BridgeSession extends EventEmitter {
  public readonly id: string;
  public readonly cascadeId: string;
  public readonly mode: BridgeMode;
  public readonly workspacePath?: string;
  public readonly requestedModel?: string;

  private readonly cascade: Cascade;
  private readonly getAutoApprovalSettings?: () => AutoApprovalSettings;
  private readonly requestedModelChoice?: RequestedModelChoice;
  private readonly bridgeCreatedAt = new Date().toISOString();
  private sourceCreatedAt?: string;

  private bridgeUpdatedAt = this.bridgeCreatedAt;
  private sourceUpdatedAt?: string;
  private title?: string;
  private runStatus = "idle";
  private latestText = "";
  private latestThinking = "";
  private lastError?: string;
  private lastEventType?: string;
  private messageCount = 0;
  private seq = 0;
  private readonly events: BridgeEvent[] = [];
  private readonly pendingApprovals = new Map<number, PendingApprovalRecord>();
  private readonly autoApprovalInFlight = new Set<number>();
  private readonly emittedStepIndexes = new Set<number>();
  private readonly emittedUserInputIndexes = new Set<number>();
  private readonly fallbackStepStatuses = new Map<number, string>();
  private readonly fallbackTextByStep = new Map<number, string>();
  private readonly fallbackThinkingByStep = new Map<number, string>();
  private readonly fallbackStdoutByStep = new Map<number, string>();
  private readonly fallbackStderrByStep = new Map<number, string>();
  private pollingFallbackActive = false;
  private pollingInFlight = false;
  private pollingTimer?: NodeJS.Timeout;
  private pollingGraceUntil = 0;

  constructor(options: SessionOptions) {
    super();
    this.id = options.id;
    this.mode = options.mode;
    this.workspacePath = options.workspacePath;
    this.requestedModelChoice = resolveRequestedModel(options.requestedModel);
    this.requestedModel = formatRequestedModel(this.requestedModelChoice);
    this.title = normalizeSessionTitle(options.title);
    this.cascade = options.cascade;
    this.cascadeId = options.cascade.cascadeId;
    this.getAutoApprovalSettings = options.getAutoApprovalSettings;

    this.bindCascade();
    this.pushEvent("session.created", {
      mode: this.mode,
      workspacePath: this.workspacePath ?? null,
      requestedModel: this.requestedModel ?? null,
    });
  }

  getSnapshot(): SessionSnapshot {
    this.refreshTrajectoryTiming(this.cascade.state.trajectory);
    return {
      id: this.id,
      cascadeId: this.cascadeId,
      mode: this.mode,
      workspacePath: this.workspacePath,
      ...(this.requestedModel ? { requestedModel: this.requestedModel } : {}),
      ...(this.title ? { title: this.title } : {}),
      live: true,
      createdAt: this.sourceCreatedAt ?? this.bridgeCreatedAt,
      updatedAt: this.sourceUpdatedAt ?? this.bridgeUpdatedAt,
      bridgeCreatedAt: this.bridgeCreatedAt,
      bridgeUpdatedAt: this.bridgeUpdatedAt,
      ...(this.sourceCreatedAt ? { sourceCreatedAt: this.sourceCreatedAt } : {}),
      ...(this.sourceUpdatedAt ? { sourceUpdatedAt: this.sourceUpdatedAt } : {}),
      runStatus: this.runStatus,
      latestText: this.latestText,
      latestThinking: this.latestThinking,
      eventCount: this.events.length,
      messageCount: this.messageCount,
      stepCount: this.emittedStepIndexes.size,
      pendingApprovals: [...this.pendingApprovals.values()].map((entry) => entry.summary),
      ...(this.lastEventType ? { lastEventType: this.lastEventType } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  getEvents(since = 0): BridgeEvent[] {
    return this.events.filter((event) => event.seq > since);
  }

  async sendMessage(text: string): Promise<void> {
    await this.cascade.sendMessage(text, this.toCascadeSendOptions());
    this.messageCount += 1;
    this.updateTitleFromText(text);
    this.kickPollingFallback();
    this.pushEvent("message.sent", {
      text,
      ...(this.requestedModel ? { requestedModel: this.requestedModel } : {}),
    });
  }

  async sendMessageWithModel(text: string, requestedModel?: string): Promise<void> {
    const override = resolveRequestedModel(requestedModel);
    await this.cascade.sendMessage(text, this.toCascadeSendOptions(override));
    this.messageCount += 1;
    this.updateTitleFromText(text);
    this.kickPollingFallback();
    this.pushEvent("message.sent", {
      text,
      requestedModel: formatRequestedModel(override ?? this.requestedModelChoice) ?? null,
    });
  }

  async cancel(): Promise<void> {
    await this.cascade.cancel();
    this.kickPollingFallback();
    this.pushEvent("session.cancel.requested", {});
  }

  async approve(stepIndex: number, scope: "once" | "conversation" = "once"): Promise<void> {
    const approval = this.pendingApprovals.get(stepIndex);
    if (!approval) {
      throw new Error(`No pending approval for step ${stepIndex}`);
    }

    await approval.request.approve(scope);
    this.pendingApprovals.delete(stepIndex);
    this.kickPollingFallback();
    this.pushEvent("cascade.approval.resolved", {
      stepIndex,
      scope,
    });
  }

  async syncFromHistory(): Promise<void> {
    const history = await this.cascade.getHistory();
    const nextRunStatus = toRunStatus(history.status);
    this.refreshTrajectoryTiming(history.trajectory);

    const steps = history.trajectory?.steps ?? [];
    steps.forEach((step, index) => {
      if (!step) {
        return;
      }
      this.processPolledStep(step, index);
    });

    if (nextRunStatus !== this.runStatus) {
      const previousStatus = this.runStatus;
      this.runStatus = nextRunStatus;
      this.pushEvent("cascade.status", {
        status: nextRunStatus,
        previousStatus,
      });
      if (previousStatus !== "idle" && nextRunStatus === "idle") {
        this.pushEvent("cascade.done", {});
      }
    }
  }

  private bindCascade(): void {
    this.cascade.on("status_change", (event: StatusChangeEvent) => {
      this.runStatus = event.status;
      this.pushEvent("cascade.status", {
        status: event.status,
        previousStatus: event.previousStatus,
      });
    });

    this.cascade.on("step:new", (event: StepNewEvent) => {
      this.emittedStepIndexes.add(event.step.index);
      this.pushStepEvent("cascade.step.new", event.step);
      this.emitUserInputIfNeeded(event.step.raw, event.step.index);
    });

    this.cascade.on("step:update", (event: StepUpdateEvent) => {
      this.pushStepEvent("cascade.step.updated", event.step, {
        previousStatus: event.previousStatus,
      });
    });

    this.cascade.on("text:delta", (event: TextDeltaEvent) => {
      this.latestText = event.fullText;
      const timing = this.getStepTiming(event.stepIndex);
      this.pushEvent("cascade.text.delta", {
        stepIndex: event.stepIndex,
        delta: event.delta,
        fullText: event.fullText,
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.viewableAt ?? timing?.sourceTimestamp);
    });

    this.cascade.on("thinking:delta", (event: ThinkingDeltaEvent) => {
      this.latestThinking = event.fullText;
      const timing = this.getStepTiming(event.stepIndex);
      this.pushEvent("cascade.thinking.delta", {
        stepIndex: event.stepIndex,
        delta: event.delta,
        fullText: event.fullText,
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.viewableAt ?? timing?.sourceTimestamp);
    });

    this.cascade.on("command_output", (event: { delta: string; text: string; outputType?: "stdout" | "stderr"; stepIndex?: number }) => {
      const timing = this.getStepTiming(event.stepIndex);
      this.pushEvent("cascade.command.output", {
        stepIndex: event.stepIndex ?? null,
        delta: event.delta,
        fullText: event.text,
        stream: event.outputType ?? "stdout",
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.completedAt ?? timing?.sourceTimestamp);
    });

    this.cascade.on("approval:needed", (request: ApprovalRequest) => {
      const summary: PendingApprovalSummary = {
        stepIndex: request.stepIndex,
        approvalType: request.type,
        description: request.description,
        autoRun: request.autoRun,
        needsApproval: request.needsApproval,
        ...(request.commandLine ? { commandLine: request.commandLine } : {}),
        ...(request.filePath ? { filePath: request.filePath } : {}),
        ...(request.isDirectory !== undefined ? { isDirectory: request.isDirectory } : {}),
        ...(request.url ? { url: request.url } : {}),
      };

      this.pendingApprovals.set(request.stepIndex, { summary, request });
      const timing = this.getStepTiming(request.stepIndex);
      this.pushEvent("cascade.approval.needed", {
        ...summary,
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.latestStatusTransitionAt ?? timing?.sourceTimestamp);
      void this.maybeAutoApprove(request.stepIndex);
    });

    this.cascade.on("done", () => {
      this.pushEvent("cascade.done", {});
    });

    this.cascade.on("error", (error: unknown) => {
      const message = stringifyError(error);
      if (message.includes("reactive state is disabled")) {
        this.startPollingFallback(message);
        return;
      }

      this.lastError = message;
      this.pushEvent("cascade.error", {
        message: this.lastError,
      });
    });
  }

  private toCascadeSendOptions(requestedModel?: RequestedModelChoice): { model?: number; modelAlias?: number } | undefined {
    const choice = requestedModel ?? this.requestedModelChoice;
    if (!choice) {
      return undefined;
    }

    return choice.kind === "alias"
      ? { modelAlias: choice.value }
      : { model: choice.value };
  }

  private startPollingFallback(reason: string): void {
    if (this.pollingFallbackActive) {
      return;
    }

    this.pollingFallbackActive = true;
    this.extendPollingGrace();
    this.pushEvent("cascade.fallback.polling", {
      reason,
      intervalMs: FALLBACK_POLL_INTERVAL_MS,
    });
    this.scheduleNextPoll(0);
  }

  private async pollHistory(): Promise<void> {
    if (this.pollingInFlight) {
      return;
    }
    this.pollingInFlight = true;

    try {
      const history = await this.cascade.getHistory();
      const nextRunStatus = toRunStatus(history.status);
      this.refreshTrajectoryTiming(history.trajectory);
      const steps = history.trajectory?.steps ?? [];
      steps.forEach((step, index) => {
        if (!step) {
          return;
        }
        this.processPolledStep(step, index);
      });

      if (nextRunStatus !== this.runStatus) {
        const previousStatus = this.runStatus;
        this.runStatus = nextRunStatus;
        this.pushEvent("cascade.status", {
          status: nextRunStatus,
          previousStatus,
        });
        if (previousStatus !== "idle" && nextRunStatus === "idle") {
          this.pushEvent("cascade.done", {});
        }
      }
    } catch (error) {
      this.lastError = stringifyError(error);
      this.pushEvent("cascade.error", {
        message: this.lastError,
      });
    } finally {
      this.pollingInFlight = false;
      if (this.shouldContinuePolling()) {
        this.scheduleNextPoll(FALLBACK_POLL_INTERVAL_MS);
      }
    }
  }

  private kickPollingFallback(): void {
    if (!this.pollingFallbackActive) {
      return;
    }
    this.extendPollingGrace();
    this.scheduleNextPoll(0);
  }

  private extendPollingGrace(durationMs = 5000): void {
    this.pollingGraceUntil = Math.max(this.pollingGraceUntil, Date.now() + Math.max(0, durationMs));
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.pollingFallbackActive || this.pollingTimer) {
      return;
    }

    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = undefined;
      void this.pollHistory();
    }, Math.max(0, delayMs));
  }

  private shouldContinuePolling(): boolean {
    return this.pollingFallbackActive
      && (this.runStatus !== "idle" || this.pendingApprovals.size > 0 || Date.now() < this.pollingGraceUntil);
  }

  private processPolledStep(step: Step, index: number): void {
    const wrapped = new CascadeStep(step, index);
    if (!this.emittedStepIndexes.has(index)) {
      this.emittedStepIndexes.add(index);
      this.pushStepEvent("cascade.step.new", wrapped);
    }
    this.emitUserInputIfNeeded(step, index);

    const currentStatus = wrapped.status;
    const previousStatus = this.fallbackStepStatuses.get(index);
    if (previousStatus && previousStatus !== currentStatus) {
      this.pushStepEvent("cascade.step.updated", wrapped, { previousStatus });
    }
    this.fallbackStepStatuses.set(index, currentStatus);

    if (step.step?.case === "plannerResponse") {
      const planner = step.step.value as any;
      const response = planner.modifiedResponse || planner.response || "";
      const thinking = planner.thinking || "";
      this.emitFallbackTextDelta(index, response);
      this.emitFallbackThinkingDelta(index, thinking);
    }

    if (step.step?.case === "runCommand") {
      const runCommand = step.step.value as any;
      this.emitFallbackCommandDelta(index, "stdout", runCommand.stdout || "");
      this.emitFallbackCommandDelta(index, "stderr", runCommand.stderr || "");
    }

    this.ensureFallbackApproval(step, index);
  }

  private emitFallbackTextDelta(stepIndex: number, fullText: string): void {
    const previous = this.fallbackTextByStep.get(stepIndex) ?? "";
    if (fullText.length <= previous.length) {
      return;
    }
    const delta = fullText.slice(previous.length);
    this.fallbackTextByStep.set(stepIndex, fullText);
    this.latestText = fullText;
    const timing = this.getStepTiming(stepIndex);
    this.pushEvent("cascade.text.delta", {
      stepIndex,
      delta,
      fullText,
      sourceTimestamp: timing?.sourceTimestamp ?? null,
      latestTimestamp: timing?.latestTimestamp ?? null,
    }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.viewableAt ?? timing?.sourceTimestamp);
  }

  private emitFallbackThinkingDelta(stepIndex: number, fullText: string): void {
    const previous = this.fallbackThinkingByStep.get(stepIndex) ?? "";
    if (fullText.length <= previous.length) {
      return;
    }
    const delta = fullText.slice(previous.length);
    this.fallbackThinkingByStep.set(stepIndex, fullText);
    this.latestThinking = fullText;
    const timing = this.getStepTiming(stepIndex);
    this.pushEvent("cascade.thinking.delta", {
      stepIndex,
      delta,
      fullText,
      sourceTimestamp: timing?.sourceTimestamp ?? null,
      latestTimestamp: timing?.latestTimestamp ?? null,
    }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.viewableAt ?? timing?.sourceTimestamp);
  }

  private emitFallbackCommandDelta(stepIndex: number, stream: "stdout" | "stderr", fullText: string): void {
    const store = stream === "stdout" ? this.fallbackStdoutByStep : this.fallbackStderrByStep;
    const previous = store.get(stepIndex) ?? "";
    if (fullText.length <= previous.length) {
      return;
    }
    const delta = fullText.slice(previous.length);
    store.set(stepIndex, fullText);
    const timing = this.getStepTiming(stepIndex);
    this.pushEvent("cascade.command.output", {
      stepIndex,
      delta,
      fullText,
      stream,
      sourceTimestamp: timing?.sourceTimestamp ?? null,
      latestTimestamp: timing?.latestTimestamp ?? null,
    }, timing?.lastCompletedChunkAt ?? timing?.finishedGeneratingAt ?? timing?.completedAt ?? timing?.sourceTimestamp);
  }

  private ensureFallbackApproval(step: Step, stepIndex: number): void {
    if (this.pendingApprovals.has(stepIndex)) {
      return;
    }

    const created = this.createFallbackApproval(step, stepIndex);
    if (!created) {
      return;
    }

    this.pendingApprovals.set(stepIndex, created);
    const timing = extractStepTiming(new CascadeStep(step, stepIndex), this.cascade.state.trajectory);
    this.pushEvent("cascade.approval.needed", {
      ...created.summary,
      sourceTimestamp: timing.sourceTimestamp ?? null,
      latestTimestamp: timing.latestTimestamp ?? null,
    }, timing.latestStatusTransitionAt ?? timing.sourceTimestamp);
    void this.maybeAutoApprove(stepIndex);
  }

  private createFallbackApproval(step: Step, stepIndex: number): PendingApprovalRecord | null {
    const wrapped = new CascadeStep(step, stepIndex);
    const interactionCase = step.requestedInteraction?.interaction?.case;
    const interactionValue = step.requestedInteraction?.interaction?.value;

    if (interactionCase === "runCommand") {
      const commandLine = (step.step?.case === "runCommand" ? (step.step.value as any).proposedCommandLine || (step.step.value as any).commandLine : "") || "";
      return {
        summary: {
          stepIndex,
          approvalType: "run_command",
          description: `Run Command: ${commandLine}`,
          autoRun: false,
          needsApproval: true,
          commandLine,
        },
        request: {
          type: "run_command",
          description: `Run Command: ${commandLine}`,
          stepIndex,
          step: wrapped,
          autoRun: false,
          needsApproval: true,
          commandLine,
          approve: async () => {
            await this.cascade.approveCommand(stepIndex, commandLine, commandLine);
          },
          deny: async () => {},
        },
      };
    }

    if (interactionCase === "filePermission") {
      const pathUri = (interactionValue as any)?.absolutePathUri || "";
      const isDirectory = !!(interactionValue as any)?.isDirectory;
      return {
        summary: {
          stepIndex,
          approvalType: "file_permission",
          description: `File Access: ${pathUri}${isDirectory ? " (directory)" : ""}`,
          autoRun: false,
          needsApproval: true,
          filePath: pathUri,
          isDirectory,
        },
        request: {
          type: "file_permission",
          description: `File Access: ${pathUri}${isDirectory ? " (directory)" : ""}`,
          stepIndex,
          step: wrapped,
          autoRun: false,
          needsApproval: true,
          filePath: pathUri,
          isDirectory,
          approve: async (scope = "once") => {
            await this.cascade.approveFilePermission(
              stepIndex,
              pathUri,
              scope === "conversation" ? PermissionScope.CONVERSATION : PermissionScope.ONCE,
            );
          },
          deny: async () => {},
        },
      };
    }

    if (interactionCase === "openBrowserUrl") {
      const url = step.step?.case === "openBrowserUrl" ? (step.step.value as any).url || "" : "";
      return {
        summary: {
          stepIndex,
          approvalType: "open_browser_url",
          description: `Open Browser: ${url}`,
          autoRun: false,
          needsApproval: true,
          url,
        },
        request: {
          type: "open_browser_url",
          description: `Open Browser: ${url}`,
          stepIndex,
          step: wrapped,
          autoRun: false,
          needsApproval: true,
          url,
          approve: async () => {
            await this.cascade.approveOpenBrowserUrl(stepIndex);
          },
          deny: async () => {},
        },
      };
    }

    return null;
  }

  private pushStepEvent(type: string, step: CascadeStep, extra: Record<string, unknown> = {}): void {
    const timing = extractStepTiming(step, this.cascade.state.trajectory);
    const detail = serializeStepDetail(step, this.cascade.state.trajectory, timing);
    this.noteSourceTimestamp(timing.sourceTimestamp);
    this.pushEvent(type, {
      stepIndex: detail.index,
      stepType: detail.type,
      category: detail.category,
      status: detail.status,
      rawStatus: detail.rawStatus,
      description: detail.description,
      hasInteraction: detail.hasInteraction,
      sourceTimestamp: timing.sourceTimestamp ?? null,
      latestTimestamp: timing.latestTimestamp ?? null,
      ...extra,
      step: detail,
    }, chooseStepEventTimestamp(type, timing));
  }

  private emitUserInputIfNeeded(step: Step, stepIndex: number): void {
    if (this.emittedUserInputIndexes.has(stepIndex)) {
      return;
    }
    if (step.step?.case !== "userInput") {
      return;
    }

    const payload = step.step.value as any;
    const text = payload.query || payload.userResponse || "";
    this.updateTitleFromText(text);
    const timing = extractStepTiming(new CascadeStep(step, stepIndex), this.cascade.state.trajectory);
    this.noteSourceTimestamp(timing.sourceTimestamp);
    this.emittedUserInputIndexes.add(stepIndex);
    this.pushEvent("cascade.user_input", {
      stepIndex,
      text,
      query: payload.query || "",
      userResponse: payload.userResponse || "",
      isQueuedMessage: !!payload.isQueuedMessage,
      itemCount: Array.isArray(payload.items) ? payload.items.length : 0,
      sourceTimestamp: timing.sourceTimestamp ?? null,
      latestTimestamp: timing.latestTimestamp ?? null,
    }, timing.createdAt ?? timing.chatStartCreatedAt ?? timing.sourceTimestamp);
  }

  private refreshTrajectoryTiming(trajectory?: Trajectory): void {
    const timing = extractTrajectoryTiming(trajectory);
    this.noteSourceTimestamp(timing.createdAt, "earliest");
    this.noteSourceTimestamp(timing.updatedAt, "latest");
  }

  private noteSourceTimestamp(timestamp?: string, mode: "earliest" | "latest" = "latest"): void {
    if (!timestamp) {
      return;
    }

    if (!this.sourceCreatedAt || timestamp.localeCompare(this.sourceCreatedAt) < 0) {
      this.sourceCreatedAt = timestamp;
    }

    if (!this.sourceUpdatedAt || timestamp.localeCompare(this.sourceUpdatedAt) > 0) {
      this.sourceUpdatedAt = timestamp;
    }

    if (mode === "earliest" && (!this.sourceCreatedAt || timestamp.localeCompare(this.sourceCreatedAt) < 0)) {
      this.sourceCreatedAt = timestamp;
    }
  }

  private getStepTiming(stepIndex: number | null | undefined): StepTimingSummary | undefined {
    if (stepIndex === null || stepIndex === undefined) {
      return undefined;
    }

    const step = this.cascade.state.trajectory?.steps?.[stepIndex];
    if (!step) {
      return undefined;
    }

    return extractStepTiming(new CascadeStep(step, stepIndex), this.cascade.state.trajectory);
  }

  private updateTitleFromText(text: string): void {
    if (this.title) {
      return;
    }
    const next = normalizeSessionTitle(text);
    if (next) {
      this.title = next;
    }
  }

  private async maybeAutoApprove(stepIndex: number): Promise<void> {
    if (this.autoApprovalInFlight.has(stepIndex)) {
      return;
    }

    const record = this.pendingApprovals.get(stepIndex);
    if (!record) {
      return;
    }

    const settings = this.getAutoApprovalSettings?.();
    const decision = selectAutoApprovalDecision(settings, record.request);
    if (!decision.shouldApprove) {
      return;
    }

    this.autoApprovalInFlight.add(stepIndex);
    const timing = this.getStepTiming(stepIndex);

    try {
      await record.request.approve(decision.scope);
      if (this.pendingApprovals.get(stepIndex)?.request === record.request) {
        this.pendingApprovals.delete(stepIndex);
      }
      this.pushEvent("cascade.approval.auto_approved", {
        stepIndex,
        approvalType: record.summary.approvalType,
        scope: decision.scope ?? null,
        reason: decision.reason,
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.latestStatusTransitionAt ?? timing?.sourceTimestamp);
    } catch (error) {
      this.pushEvent("cascade.approval.auto_approve.failed", {
        stepIndex,
        approvalType: record.summary.approvalType,
        scope: decision.scope ?? null,
        reason: decision.reason,
        message: stringifyError(error),
        sourceTimestamp: timing?.sourceTimestamp ?? null,
        latestTimestamp: timing?.latestTimestamp ?? null,
      }, timing?.latestStatusTransitionAt ?? timing?.sourceTimestamp);
    } finally {
      this.autoApprovalInFlight.delete(stepIndex);
    }
  }

  private pushEvent(type: string, data: Record<string, unknown>, sourceTimestamp?: string): BridgeEvent {
    this.refreshTrajectoryTiming(this.cascade.state.trajectory);
    this.noteSourceTimestamp(sourceTimestamp);
    const recordedAt = new Date().toISOString();
    const event: BridgeEvent = {
      seq: ++this.seq,
      sessionId: this.id,
      cascadeId: this.cascadeId,
      timestamp: sourceTimestamp ?? recordedAt,
      recordedAt,
      ...(sourceTimestamp ? { sourceTimestamp } : {}),
      type,
      data,
    };

    this.bridgeUpdatedAt = recordedAt;
    this.lastEventType = event.type;
    this.events.push(event);
    this.emit("event", event);
    return event;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function serializeStepDetail(step: CascadeStep, trajectory?: Trajectory, timing = extractStepTiming(step, trajectory)): Record<string, unknown> {
  const raw = step.raw;
  return {
    index: step.index,
    type: step.type,
    category: step.category,
    status: step.status,
    rawStatus: step.rawStatus,
    description: step.description,
    hasInteraction: step.hasInteraction,
    sourceTimestamp: timing.sourceTimestamp ?? null,
    latestTimestamp: timing.latestTimestamp ?? null,
    timing: {
      chatStartCreatedAt: timing.chatStartCreatedAt ?? null,
      createdAt: timing.createdAt ?? null,
      viewableAt: timing.viewableAt ?? null,
      finishedGeneratingAt: timing.finishedGeneratingAt ?? null,
      lastCompletedChunkAt: timing.lastCompletedChunkAt ?? null,
      completedAt: timing.completedAt ?? null,
      latestStatusTransitionAt: timing.latestStatusTransitionAt ?? null,
      statusTransitions: timing.statusTransitions,
    },
    stepCase: raw.step?.case ?? null,
    interactionCase: raw.requestedInteraction?.interaction?.case ?? null,
    completedInteractionCount: raw.completedInteractions.length,
    metadata: serializeProtoValue(raw.metadata),
    error: serializeProtoValue(raw.error),
    permissions: serializeProtoValue(raw.permissions),
    taskDetails: serializeProtoValue(raw.taskDetails),
    requestedInteraction: serializeProtoValue(raw.requestedInteraction),
    completedInteractions: raw.completedInteractions.map((entry) => serializeProtoValue(entry)),
    userAnnotations: serializeProtoValue(raw.userAnnotations),
    subtrajectory: serializeProtoValue(raw.subtrajectory),
    payload: serializeProtoValue(raw.step?.value),
    raw: serializeProtoValue(raw),
  };
}

function serializeProtoValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeProtoValue(entry));
  }

  if (typeof value !== "object") {
    return value;
  }

  if ("toJson" in value && typeof value.toJson === "function") {
    return value.toJson({ emitDefaultValues: true });
  }

  const serializedEntries = Object.entries(value).map(([key, entry]) => [key, serializeProtoValue(entry)]);
  return Object.fromEntries(serializedEntries);
}

function extractTrajectoryTiming(trajectory?: Trajectory): { createdAt?: string; updatedAt?: string } {
  if (!trajectory) {
    return {};
  }

  const timestamps = [
    decodeProtoTimestamp(trajectory.metadata?.createdAt),
    ...trajectory.steps
      .map((step, index) => step ? extractStepTiming(new CascadeStep(step, index), trajectory).latestTimestamp : undefined)
      .filter((value): value is string => Boolean(value)),
  ];

  return {
    createdAt: pickEarliestTimestamp(timestamps),
    updatedAt: pickLatestTimestamp(timestamps),
  };
}

function extractStepTiming(step: CascadeStep, trajectory?: Trajectory): StepTimingSummary {
  const metadata = step.raw.metadata;
  const chatStartCreatedAt = findChatStartCreatedAt(trajectory, step.index);
  const createdAt = decodeProtoTimestamp(metadata?.createdAt);
  const viewableAt = decodeProtoTimestamp(metadata?.viewableAt);
  const finishedGeneratingAt = decodeProtoTimestamp(metadata?.finishedGeneratingAt);
  const lastCompletedChunkAt = decodeProtoTimestamp(metadata?.lastCompletedChunkAt);
  const completedAt = decodeProtoTimestamp(metadata?.completedAt);
  const statusTransitions = (metadata?.internalMetadata?.statusTransitions ?? []).map((transition) => ({
    updatedStatus: transition.updatedStatus,
    timestamp: decodeProtoTimestamp(transition.timestamp) ?? null,
  }));
  const latestStatusTransitionAt = pickLatestTimestamp(statusTransitions.map((entry) => entry.timestamp ?? undefined));
  const sourceTimestamp = pickLatestTimestamp([
    completedAt,
    lastCompletedChunkAt,
    finishedGeneratingAt,
    viewableAt,
    latestStatusTransitionAt,
    createdAt,
    chatStartCreatedAt,
  ]);
  const latestTimestamp = pickLatestTimestamp([
    chatStartCreatedAt,
    createdAt,
    viewableAt,
    finishedGeneratingAt,
    lastCompletedChunkAt,
    completedAt,
    latestStatusTransitionAt,
  ]);

  return {
    chatStartCreatedAt,
    createdAt,
    viewableAt,
    finishedGeneratingAt,
    lastCompletedChunkAt,
    completedAt,
    latestStatusTransitionAt,
    statusTransitions,
    sourceTimestamp,
    latestTimestamp,
  };
}

function findChatStartCreatedAt(trajectory: Trajectory | undefined, stepIndex: number): string | undefined {
  if (!trajectory) {
    return undefined;
  }

  return pickEarliestTimestamp(
    trajectory.generatorMetadata.map((metadata) => {
      if (!metadata.stepIndices.includes(stepIndex)) {
        return undefined;
      }
      if (metadata.metadata.case !== "chatModel") {
        return undefined;
      }
      return decodeProtoTimestamp(metadata.metadata.value.chatStartMetadata?.createdAt);
    }),
  );
}

function chooseStepEventTimestamp(type: string, timing: StepTimingSummary): string | undefined {
  if (type === "cascade.step.new") {
    return timing.createdAt ?? timing.chatStartCreatedAt ?? timing.sourceTimestamp;
  }

  return timing.latestTimestamp ?? timing.sourceTimestamp;
}

function decodeProtoTimestamp(value: Uint8Array | undefined): string | undefined {
  if (!value || value.length === 0) {
    return undefined;
  }

  try {
    return Timestamp.fromBinary(value).toDate().toISOString();
  } catch {
    return undefined;
  }
}

function pickEarliestTimestamp(values: Array<string | undefined | null>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right))[0];
}

function pickLatestTimestamp(values: Array<string | undefined | null>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0];
}

function normalizeSessionTitle(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }

  return compact.length <= 80 ? compact : `${compact.slice(0, 77)}...`;
}

function selectAutoApprovalDecision(
  settings: AutoApprovalSettings | undefined,
  request: ApprovalRequest,
): { shouldApprove: boolean; scope?: "once" | "conversation"; reason?: string } {
  if (!settings?.enabled || !request.needsApproval) {
    return { shouldApprove: false };
  }

  switch (request.type) {
    case "run_command":
      return settings.runCommands
        ? { shouldApprove: true, reason: "auto-approval runCommands" }
        : { shouldApprove: false };
    case "file_permission":
      return settings.filePermissions
        ? { shouldApprove: true, scope: settings.filePermissionScope, reason: "auto-approval filePermissions" }
        : { shouldApprove: false };
    case "open_browser_url":
      return settings.openBrowser
        ? { shouldApprove: true, reason: "auto-approval openBrowser" }
        : { shouldApprove: false };
    case "browser_action":
      return settings.browserActions
        ? { shouldApprove: true, reason: "auto-approval browserActions" }
        : { shouldApprove: false };
    case "send_command_input":
      return settings.sendCommandInput
        ? { shouldApprove: true, reason: "auto-approval sendCommandInput" }
        : { shouldApprove: false };
    default:
      return { shouldApprove: false };
  }
}

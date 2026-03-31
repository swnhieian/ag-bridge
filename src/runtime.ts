import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { AntigravityClient } from "../vendor/antigravity-client/src/client.js";
import { GetAllCascadeTrajectoriesRequest } from "../vendor/antigravity-client/src/gen/exa/language_server_pb/language_server_pb.js";
import type { Launcher } from "../vendor/antigravity-client/src/server/index.js";
import { toRunStatus } from "../vendor/antigravity-client/src/types.js";

import { BridgeSession } from "./bridge-session.js";
import { BridgePersistenceStore } from "./persistence.js";
import type {
  AgSessionSummary,
  AutoApprovalSettings,
  AvailableModelSummary,
  BridgeMode,
  ServerStatus,
  SessionCreateOptions,
  SessionExport,
  SessionSnapshot,
} from "./types.js";

interface ManagedClient {
  key: string;
  mode: BridgeMode;
  workspacePath?: string;
  client: AntigravityClient;
  launcher?: Launcher;
}

interface RuntimeOptions {
  defaultWorkspacePath?: string;
  dataDir?: string;
}

export class BridgeRuntime {
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly clients = new Map<string, ManagedClient>();
  private sessionCounter = 0;
  private readonly defaultWorkspacePath?: string;
  private readonly store: BridgePersistenceStore;
  private autoApprovalSettings: AutoApprovalSettings = defaultAutoApprovalSettings();

  constructor(options: RuntimeOptions = {}) {
    this.defaultWorkspacePath = options.defaultWorkspacePath;
    this.store = new BridgePersistenceStore(options.dataDir ?? defaultDataDir());
  }

  get dataDir(): string {
    return this.store.dataDir;
  }

  async createSession(options: SessionCreateOptions = {}): Promise<BridgeSession> {
    const mode = options.mode ?? "connect";
    const workspacePath = options.workspacePath ?? this.defaultWorkspacePath ?? process.cwd();
    const managedClient = await this.getOrCreateClient(mode, workspacePath);
    const cascade = await managedClient.client.startCascade();
    const id = this.allocateSessionId(options.sessionId);

    return this.registerLiveSession(
      new BridgeSession({
        id,
        mode,
        workspacePath,
        requestedModel: options.model,
        cascade,
        getAutoApprovalSettings: () => this.autoApprovalSettings,
      }),
    );
  }

  async discoverAgSessions(workspacePath?: string): Promise<AgSessionSummary[]> {
    const managedClient = await this.getOrCreateClient("connect", workspacePath);
    const response = await managedClient.client.lsClient.getAllCascadeTrajectories(new GetAllCascadeTrajectoriesRequest({}));

    return response.trajectorySummaries
      .map((entry) => {
        const attached = this.findLiveSessionByCascadeId(entry.key);
        const workspacePaths = (entry.value?.workspaces ?? [])
          .map((workspace) => toPathIfFileUri(workspace.workspaceFolderAbsoluteUri))
          .filter(Boolean) as string[];

        return {
          cascadeId: entry.key,
          trajectoryId: entry.value?.trajectoryId ?? "",
          ...(entry.value?.annotations?.title ? { title: entry.value.annotations.title } : {}),
          summary: entry.value?.summary ?? "",
          runStatus: toRunStatus(entry.value?.status ?? 0),
          stepCount: entry.value?.stepCount ?? 0,
          lastUserInputStepIndex: entry.value?.lastUserInputStepIndex ?? 0,
          workspacePaths,
          ...(attached ? { attachedSessionId: attached.id } : {}),
          live: !!attached,
        } satisfies AgSessionSummary;
      })
      .filter((summary) => !workspacePath || summary.workspacePaths.length === 0 || summary.workspacePaths.includes(workspacePath))
      .sort((left, right) => right.stepCount - left.stepCount);
  }

  async listAvailableModels(workspacePath?: string): Promise<AvailableModelSummary[]> {
    const managedClient = await this.getOrCreateClient("connect", workspacePath);
    const models = await managedClient.client.getAvailableModels();

    return Object.entries(models)
      .map(([key, model]) => {
        if (model.alias && model.aliasId !== undefined) {
          return {
            key,
            label: model.label,
            kind: "alias",
            name: model.alias,
            id: model.aliasId,
            isPremium: model.isPremium,
            isRecommended: model.isRecommended,
            disabled: model.disabled,
          } satisfies AvailableModelSummary;
        }

        return {
          key,
          label: model.label,
          kind: "model",
          name: model.model ?? "UNSPECIFIED",
          id: model.modelId ?? 0,
          isPremium: model.isPremium,
          isRecommended: model.isRecommended,
          disabled: model.disabled,
        } satisfies AvailableModelSummary;
      })
      .sort((left, right) => {
        if (left.disabled !== right.disabled) {
          return left.disabled ? 1 : -1;
        }
        if (left.isRecommended !== right.isRecommended) {
          return left.isRecommended ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      });
  }

  async attachAgSession(cascadeId: string, workspacePath?: string): Promise<BridgeSession> {
    const existing = this.findLiveSessionByCascadeId(cascadeId);
    if (existing) {
      return existing;
    }

    const managedClient = await this.getOrCreateClient("connect", workspacePath);
    const cascade = managedClient.client.getCascade(cascadeId);
    const persisted = this.findPersistedSessionByCascadeId(cascadeId);
    const discovered = (await this.discoverAgSessions(workspacePath)).find((entry) => entry.cascadeId === cascadeId);
    const id = persisted?.id ?? this.allocateSessionId();
    const nextWorkspacePath = workspacePath ?? persisted?.workspacePath;

    return this.registerLiveSession(
      new BridgeSession({
        id,
        mode: "connect",
        workspacePath: nextWorkspacePath,
        requestedModel: persisted?.requestedModel,
        title: persisted?.title ?? discovered?.title,
        cascade,
        getAutoApprovalSettings: () => this.autoApprovalSettings,
      }),
    );
  }

  async resumeSession(id: string, workspacePath?: string): Promise<BridgeSession> {
    const live = this.sessions.get(id);
    if (live) {
      return live;
    }

    const stored = this.store.getSession(id);
    if (!stored) {
      throw new Error(`Session not found: ${id}`);
    }

    return this.attachAgSession(stored.cascadeId, workspacePath ?? stored.workspacePath);
  }

  getAutoApprovalSettings(): AutoApprovalSettings {
    return { ...this.autoApprovalSettings };
  }

  updateAutoApprovalSettings(next: Partial<AutoApprovalSettings>): AutoApprovalSettings {
    this.autoApprovalSettings = normalizeAutoApprovalSettings({
      ...this.autoApprovalSettings,
      ...next,
    });
    return this.getAutoApprovalSettings();
  }

  async attachAllAgSessions(workspacePath?: string): Promise<{ discovered: AgSessionSummary[]; attached: SessionSnapshot[] }> {
    const discovered = await this.discoverAgSessions(workspacePath);
    const attached: SessionSnapshot[] = [];

    for (const summary of discovered) {
      const session = await this.attachAgSession(summary.cascadeId, workspacePath ?? summary.workspacePaths[0]);
      attached.push(session.getSnapshot());
    }

    return {
      discovered: await this.discoverAgSessions(workspacePath),
      attached,
    };
  }

  listSessions(): SessionSnapshot[] {
    const merged = new Map<string, SessionSnapshot>();
    for (const snapshot of this.store.listSessions()) {
      merged.set(snapshot.id, snapshot);
    }
    for (const session of this.sessions.values()) {
      merged.set(session.id, session.getSnapshot());
    }
    return [...merged.values()].sort(compareByUpdatedAtDesc);
  }

  getSessionSnapshot(id: string): SessionSnapshot {
    const live = this.sessions.get(id);
    if (live) {
      return live.getSnapshot();
    }

    const stored = this.store.getSession(id);
    if (stored) {
      return stored;
    }

    throw new Error(`Session not found: ${id}`);
  }

  getLiveSession(id: string): BridgeSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Live session not found: ${id}`);
    }
    return session;
  }

  getSessionEvents(id: string, since = 0, limit?: number): SessionSnapshotEventsResult {
    const live = this.sessions.get(id);
    if (live) {
      const events = live.getEvents(since);
      return {
        session: live.getSnapshot(),
        events: !limit || limit <= 0 || events.length <= limit ? events : events.slice(events.length - limit),
      };
    }

    const stored = this.store.getSession(id);
    if (!stored) {
      throw new Error(`Session not found: ${id}`);
    }

    return {
      session: stored,
      events: this.store.getEvents(id, since, limit),
    };
  }

  exportSession(id: string): SessionExport {
    const live = this.sessions.get(id);
    if (live) {
      return {
        session: live.getSnapshot(),
        events: live.getEvents(),
      };
    }

    const exported = this.store.exportSession(id);
    if (!exported) {
      throw new Error(`Session not found: ${id}`);
    }
    return exported;
  }

  deleteSession(id: string): boolean {
    if (this.sessions.has(id)) {
      throw new Error(`Cannot delete live session: ${id}`);
    }
    return this.store.deleteSession(id);
  }

  getRuntimeStats(): RuntimeStats {
    return {
      sessionCount: this.listSessions().length,
      liveSessionCount: this.sessions.size,
      persistedSessionCount: this.store.listSessions().length,
      clientCount: this.clients.size,
      defaultMode: "connect",
    };
  }

  getHealth(): Record<string, unknown> {
    const stats = this.getRuntimeStats();
    return {
      ok: true,
      ...stats,
      dataDir: this.dataDir,
    };
  }

  buildServerStatus(server: {
    running: boolean;
    host: string;
    requestedPort: number;
    actualPort?: number;
    address?: string;
    switchedPort: boolean;
    startedAt?: string;
  }): ServerStatus {
    const stats = this.getRuntimeStats();
    const startedAt = server.startedAt;
    return {
      ok: true,
      running: server.running,
      host: server.host,
      requestedPort: server.requestedPort,
      ...(server.actualPort ? { actualPort: server.actualPort } : {}),
      ...(server.address ? { address: server.address } : {}),
      switchedPort: server.switchedPort,
      dataDir: this.dataDir,
      ...(startedAt ? { startedAt } : {}),
      ...(startedAt ? { uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) } : {}),
      ...stats,
    };
  }

  private registerLiveSession(session: BridgeSession): BridgeSession {
    this.sessions.set(session.id, session);
    this.store.syncSession(session.getSnapshot(), session.getEvents());
    session.on("event", (event) => {
      this.store.recordEvent(session.getSnapshot(), event);
    });
    return session;
  }

  private findLiveSessionByCascadeId(cascadeId: string): BridgeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.cascadeId === cascadeId) {
        return session;
      }
    }
    return undefined;
  }

  private findPersistedSessionByCascadeId(cascadeId: string): SessionSnapshot | undefined {
    return this.store.listSessions().find((session) => session.cascadeId === cascadeId);
  }

  private allocateSessionId(requestedId?: string): string {
    if (requestedId !== undefined) {
      this.assertValidSessionId(requestedId);
      this.assertSessionIdAvailable(requestedId);
      return requestedId;
    }

    let generated = "";
    do {
      generated = `sess_${Date.now()}_${++this.sessionCounter}`;
    } while (this.hasSessionId(generated));
    return generated;
  }

  private assertValidSessionId(id: string): void {
    if (!id || typeof id !== "string") {
      throw new Error("Field `sessionId` must be a non-empty string.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new Error("Field `sessionId` must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.");
    }
  }

  private assertSessionIdAvailable(id: string): void {
    if (this.hasSessionId(id)) {
      throw new Error(`Session id already exists: ${id}`);
    }
  }

  private hasSessionId(id: string): boolean {
    return this.sessions.has(id) || !!this.store.getSession(id);
  }

  private async getOrCreateClient(mode: BridgeMode, workspacePath?: string): Promise<ManagedClient> {
    const key = `${mode}:${workspacePath ?? ""}`;
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }

    let managed: ManagedClient;
    if (mode === "launch") {
      const launched = await AntigravityClient.launch({
        workspacePath,
        verbose: false,
      });
      managed = {
        key,
        mode,
        workspacePath,
        client: launched,
        launcher: launched.launcher,
      };
    } else {
      const client = await AntigravityClient.connect({
        autoDetect: true,
        workspacePath,
      });
      managed = {
        key,
        mode,
        workspacePath,
        client,
      };
    }

    this.clients.set(key, managed);
    return managed;
  }
}

interface SessionSnapshotEventsResult {
  session: SessionSnapshot;
  events: ReturnType<BridgeSession["getEvents"]>;
}

interface RuntimeStats {
  sessionCount: number;
  liveSessionCount: number;
  persistedSessionCount: number;
  clientCount: number;
  defaultMode: "connect";
}

function compareByUpdatedAtDesc(left: SessionSnapshot, right: SessionSnapshot): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function defaultDataDir(): string {
  return path.join(os.homedir(), ".ag-bridge");
}

function defaultAutoApprovalSettings(): AutoApprovalSettings {
  return {
    enabled: false,
    runCommands: false,
    filePermissions: false,
    filePermissionScope: "once",
    openBrowser: false,
    browserActions: false,
    sendCommandInput: false,
  };
}

function normalizeAutoApprovalSettings(settings: Partial<AutoApprovalSettings>): AutoApprovalSettings {
  return {
    enabled: !!settings.enabled,
    runCommands: !!settings.runCommands,
    filePermissions: !!settings.filePermissions,
    filePermissionScope: settings.filePermissionScope === "conversation" ? "conversation" : "once",
    openBrowser: !!settings.openBrowser,
    browserActions: !!settings.browserActions,
    sendCommandInput: !!settings.sendCommandInput,
  };
}

function toPathIfFileUri(value: string): string {
  if (!value) {
    return value;
  }
  if (!value.startsWith("file://")) {
    return value;
  }
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

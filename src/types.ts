export type BridgeMode = "connect" | "launch";

export interface SessionCreateOptions {
  mode?: BridgeMode;
  workspacePath?: string;
  model?: string;
  sessionId?: string;
}

export interface AutoApprovalSettings {
  enabled: boolean;
  runCommands: boolean;
  filePermissions: boolean;
  filePermissionScope: "once" | "conversation";
  openBrowser: boolean;
  browserActions: boolean;
  sendCommandInput: boolean;
}

export interface BridgeEvent {
  seq: number;
  sessionId: string;
  cascadeId: string;
  timestamp: string;
  recordedAt: string;
  sourceTimestamp?: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PendingApprovalSummary {
  stepIndex: number;
  approvalType: string;
  description: string;
  autoRun: boolean;
  needsApproval: boolean;
  commandLine?: string;
  filePath?: string;
  isDirectory?: boolean;
  url?: string;
}

export interface AvailableModelSummary {
  key: string;
  label: string;
  kind: "model" | "alias";
  name: string;
  id: number;
  aliases?: string[];
  isPremium: boolean;
  isRecommended: boolean;
  disabled: boolean;
}

export interface SessionSnapshot {
  id: string;
  cascadeId: string;
  mode: BridgeMode;
  workspacePath?: string;
  requestedModel?: string;
  title?: string;
  live: boolean;
  createdAt: string;
  updatedAt: string;
  bridgeCreatedAt: string;
  bridgeUpdatedAt: string;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
  runStatus: string;
  latestText: string;
  latestThinking: string;
  eventCount: number;
  messageCount: number;
  stepCount: number;
  pendingApprovals: PendingApprovalSummary[];
  lastEventType?: string;
  lastError?: string;
}

export interface SessionExport {
  session: SessionSnapshot;
  events: BridgeEvent[];
}

export interface ServerStatus {
  ok: true;
  running: boolean;
  host: string;
  requestedPort: number;
  actualPort?: number;
  address?: string;
  switchedPort: boolean;
  dataDir: string;
  startedAt?: string;
  uptimeSeconds?: number;
  defaultMode: "connect";
  sessionCount: number;
  liveSessionCount: number;
  persistedSessionCount: number;
  clientCount: number;
}

export interface AgSessionSummary {
  cascadeId: string;
  trajectoryId: string;
  title?: string;
  summary: string;
  runStatus: string;
  stepCount: number;
  lastUserInputStepIndex: number;
  workspacePaths: string[];
  attachedSessionId?: string;
  live: boolean;
}

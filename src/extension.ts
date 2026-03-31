import type * as VSCode from "vscode";

import { BridgeHttpServer } from "./http-server.js";
import type { AutoApprovalSettings, BridgeEvent, ServerStatus, SessionExport, SessionSnapshot } from "./types.js";

class ExtensionBridgeController {
  private server?: BridgeHttpServer;
  private lastStartError?: string;
  private panel?: VSCode.WebviewPanel;
  private refreshTimer?: NodeJS.Timeout;
  private readonly output: VSCode.OutputChannel;
  private readonly statusItem: VSCode.StatusBarItem;
  readonly ui: UiCopy;
  private autoApprovalSettings: AutoApprovalSettings = defaultAutoApprovalSettings();
  private readonly expandedSessionIds = new Set<string>();

  constructor(
    private readonly vscode: typeof VSCode,
    private readonly context: VSCode.ExtensionContext,
  ) {
    this.ui = getUiCopy(vscode.env.language);
    this.output = vscode.window.createOutputChannel("AG Bridge");
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.statusItem.command = "agBridge.openDashboard";
    this.statusItem.show();
    this.updateStatusBar();
  }

  async start(): Promise<void> {
    if (this.server?.running) {
      await this.renderDashboard();
      return;
    }

    const config = this.vscode.workspace.getConfiguration("agBridge");
    const host = config.get<string>("server.host", "127.0.0.1");
    const port = config.get<number>("server.port", 9464);
    const workspacePath = this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const dataDir = this.context.globalStorageUri.fsPath;

    this.server = new BridgeHttpServer({
      host,
      port,
      defaultWorkspacePath: workspacePath,
      dataDir,
    });

    try {
      await this.server.start();
      this.server.updateAutoApprovalSettings(this.autoApprovalSettings);
      this.lastStartError = undefined;
      const status = this.server.getStatus();
      this.output.appendLine(`[${new Date().toISOString()}] ${this.ui.outputStarted}: ${status.address}`);
      if (status.switchedPort) {
        this.output.appendLine(
          `[${new Date().toISOString()}] ${this.ui.outputPortSwitched(status.requestedPort, status.actualPort)}`,
        );
      }
    } catch (error) {
      this.lastStartError = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] ${this.ui.outputStartFailed}: ${this.lastStartError}`);
      await this.renderDashboard();
      throw error;
    }

    this.updateStatusBar();
    await this.renderDashboard();
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await this.server.stop();
    this.output.appendLine(`[${new Date().toISOString()}] ${this.ui.outputStopped}`);
    this.server = undefined;
    this.updateStatusBar();
    await this.renderDashboard();
  }

  async showStatus(): Promise<void> {
    await this.openDashboard();
  }

  async syncAgSessions(): Promise<void> {
    if (!this.server?.running) {
      void this.vscode.window.showWarningMessage(this.ui.syncRequiresRunning);
      return;
    }

    const result = await this.server.attachAllAgSessions();
    await this.renderDashboard();
    void this.vscode.window.showInformationMessage(
      this.ui.syncFinished(result.discovered.length, result.attached.length),
    );
  }

  async saveAutoApprovalSettings(next: Partial<AutoApprovalSettings>): Promise<void> {
    this.autoApprovalSettings = normalizeAutoApprovalSettings({
      ...this.autoApprovalSettings,
      ...next,
    });

    if (this.server?.running) {
      this.autoApprovalSettings = this.server.updateAutoApprovalSettings(this.autoApprovalSettings);
    }

    await this.renderDashboard();
    void this.vscode.window.showInformationMessage(this.ui.autoApprovalSaved);
  }

  getStatus(): ServerStatus | undefined {
    return this.server?.getStatus();
  }

  async openDashboard(): Promise<void> {
    if (!this.panel) {
      this.panel = this.vscode.window.createWebviewPanel(
        "agBridge.dashboard",
        this.ui.dashboardTitle,
        this.vscode.ViewColumn.Active,
        { enableScripts: true },
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        if (this.refreshTimer) {
          clearInterval(this.refreshTimer);
          this.refreshTimer = undefined;
        }
      });

      this.panel.webview.onDidReceiveMessage(async (message: { type?: string; settings?: Partial<AutoApprovalSettings>; sessionId?: string }) => {
        switch (message.type) {
          case "start":
            try {
              await this.start();
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              void this.vscode.window.showErrorMessage(this.ui.startFailedMessage(text));
            }
            return;
          case "stop":
            await this.stop();
            return;
          case "refresh":
            await this.renderDashboard();
            return;
          case "copy-address": {
            const status = this.server?.getStatus();
            if (!status?.address) {
              void this.vscode.window.showWarningMessage(this.ui.copyAddressUnavailable);
              return;
            }
            await this.vscode.env.clipboard.writeText(status.address);
            void this.vscode.window.showInformationMessage(this.ui.copyAddressDone(status.address));
            return;
          }
          case "sync-ag-sessions":
            await this.syncAgSessions();
            return;
          case "save-auto-approval":
            await this.saveAutoApprovalSettings(message.settings ?? {});
            return;
          case "toggle-session-detail":
            if (!message.sessionId) {
              return;
            }
            if (this.expandedSessionIds.has(message.sessionId)) {
              this.expandedSessionIds.delete(message.sessionId);
            } else {
              this.expandedSessionIds.add(message.sessionId);
            }
            await this.renderDashboard();
            return;
          case "open-health": {
            const status = this.server?.getStatus();
            if (status?.address) {
              await this.vscode.env.openExternal(this.vscode.Uri.parse(`${status.address}/health`));
            }
            return;
          }
          case "open-status": {
            const status = this.server?.getStatus();
            if (status?.address) {
              await this.vscode.env.openExternal(this.vscode.Uri.parse(`${status.address}/status`));
            }
            return;
          }
          default:
            return;
        }
      });

      this.refreshTimer = setInterval(() => {
        void this.renderDashboard();
      }, 3000);
    } else {
      this.panel.reveal(this.vscode.ViewColumn.Active);
    }
    await this.renderDashboard();
  }

  dispose(): void {
    void this.stop();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.panel?.dispose();
    this.statusItem.dispose();
    this.output.dispose();
  }

  private updateStatusBar(): void {
    const status = this.server?.getStatus();
    if (status?.running && status.address) {
      this.statusItem.text = `$(radio-tower) AG Bridge ${status.actualPort}`;
      this.statusItem.tooltip = this.ui.statusBarRunning(status.address);
      return;
    }

    this.statusItem.text = this.ui.statusBarStoppedText;
    this.statusItem.tooltip = this.lastStartError ? this.ui.statusBarStartFailed(this.lastStartError) : this.ui.statusBarStoppedTooltip;
  }

  private async renderDashboard(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const model = this.getDashboardModel();
    this.panel.webview.html = renderDashboardHtml(model, this.ui);
    this.updateStatusBar();
  }

  private getDashboardModel(): DashboardModel {
    const config = this.vscode.workspace.getConfiguration("agBridge");
    const workspacePath = this.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.ui.workspaceNotDetected;
    const status =
      this.server?.getStatus() ??
      createStoppedStatus({
        host: config.get<string>("server.host", "127.0.0.1"),
        requestedPort: config.get<number>("server.port", 9464),
        dataDir: this.context.globalStorageUri.fsPath,
      });

    const sessions = this.server?.listSessions() ?? [];
    const sessionExports: Record<string, SessionExport | undefined> = {};
    const liveSessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of [...this.expandedSessionIds]) {
      if (!liveSessionIds.has(sessionId)) {
        this.expandedSessionIds.delete(sessionId);
        continue;
      }
      try {
        sessionExports[sessionId] = this.server?.exportSession(sessionId);
      } catch (error) {
        this.output.appendLine(
          `[${new Date().toISOString()}] ${this.ui.outputReadSessionDetailFailed(sessionId, error instanceof Error ? error.message : String(error))}`,
        );
      }
    }

    return {
      status,
      sessions,
      workspacePath,
      extensionVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
      lastStartError: this.lastStartError,
      autoApprovalSettings: this.server?.running ? this.server.getAutoApprovalSettings() : this.autoApprovalSettings,
      expandedSessionIds: new Set(this.expandedSessionIds),
      sessionExports,
    };
  }
}

interface DashboardModel {
  status: ServerStatus;
  sessions: SessionSnapshot[];
  workspacePath: string;
  extensionVersion: string;
  lastStartError?: string;
  autoApprovalSettings: AutoApprovalSettings;
  expandedSessionIds: Set<string>;
  sessionExports: Record<string, SessionExport | undefined>;
}

let controller: ExtensionBridgeController | undefined;

export async function activateExtension(
  vscode: typeof VSCode,
  context: VSCode.ExtensionContext,
): Promise<void> {
  controller = new ExtensionBridgeController(vscode, context);

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("agBridge.startServer", async () => {
      await controller?.start();
      const status = controller?.getStatus();
      if (status?.switchedPort) {
        void vscode.window.showWarningMessage(
          controller?.ui.commandStartedWithPortSwitch(status.requestedPort, status.actualPort) ?? "",
        );
      } else {
        void vscode.window.showInformationMessage(controller?.ui.commandStarted ?? "");
      }
    }),
    vscode.commands.registerCommand("agBridge.stopServer", async () => {
      await controller?.stop();
      void vscode.window.showInformationMessage(controller?.ui.commandStopped ?? "");
    }),
    vscode.commands.registerCommand("agBridge.showStatus", async () => {
      await controller?.showStatus();
    }),
    vscode.commands.registerCommand("agBridge.openDashboard", async () => {
      await controller?.openDashboard();
    }),
  );

  const autoStart = vscode.workspace.getConfiguration("agBridge").get<boolean>("autoStart", true);
  if (autoStart) {
    try {
      await controller.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(controller.ui.startFailedMessage(message));
    }
  }
}

export async function deactivateExtension(): Promise<void> {
  await controller?.stop();
}

function createStoppedStatus(options: {
  host: string;
  requestedPort: number;
  dataDir: string;
}): ServerStatus {
  return {
    ok: true,
    running: false,
    host: options.host,
    requestedPort: options.requestedPort,
    switchedPort: false,
    dataDir: options.dataDir,
    defaultMode: "connect",
    sessionCount: 0,
    liveSessionCount: 0,
    persistedSessionCount: 0,
    clientCount: 0,
  };
}

function renderDashboardHtml(model: DashboardModel, ui: UiCopy): string {
  const { status, sessions, workspacePath, extensionVersion, lastStartError, autoApprovalSettings, expandedSessionIds, sessionExports } = model;
  const portNotice =
    status.running && status.switchedPort
      ? `<div class="notice warning">${ui.dashboardPortNotice(status.requestedPort, status.actualPort)}</div>`
      : "";
  const errorNotice = lastStartError ? `<div class="notice error">${ui.dashboardLastStartFailed}: ${escapeHtml(lastStartError)}</div>` : "";
  const sessionRows =
    sessions.length === 0
      ? `<tr><td colspan="9" class="muted">${ui.dashboardNoSessions}</td></tr>`
      : sessions
          .map(
            (session) => {
              const expanded = expandedSessionIds.has(session.id);
              const details = expanded ? renderSessionDetails(sessionExports[session.id], session, ui) : "";
              return `
              <tr class="session-row">
                <td>
                  <button class="icon-button" data-action="toggle-session-detail" data-session-id="${escapeHtml(session.id)}" aria-expanded="${expanded ? "true" : "false"}">
                    ${expanded ? ui.dashboardCollapse : ui.dashboardExpand}
                  </button>
                </td>
                <td><code>${escapeHtml(session.id)}</code></td>
                <td title="${escapeHtml(session.title ?? "")}">${escapeHtml(session.title ?? "-")}</td>
                <td>${session.live ? "live" : "disk"}</td>
                <td>${escapeHtml(session.mode)}</td>
                <td>${escapeHtml(session.runStatus)}</td>
                <td>${session.messageCount}</td>
                <td>${session.stepCount}</td>
                <td title="${escapeHtml(session.latestText || session.latestThinking)}">${escapeHtml(truncate(session.latestText || session.latestThinking, 80))}</td>
              </tr>
              ${details}`;
            },
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="${ui.htmlLang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${ui.dashboardTitle}</title>
    <style>
      :root {
        color-scheme: light dark;
        --page-bg: var(--vscode-editor-background);
        --panel-bg: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
        --panel-bg-elevated: var(--vscode-editorWidget-background, var(--vscode-editor-background));
        --panel-border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.25)));
        --text-main: var(--vscode-foreground);
        --text-muted: var(--vscode-descriptionForeground, var(--vscode-disabledForeground, rgba(127, 127, 127, 0.9)));
        --button-bg: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        --button-fg: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        --button-hover: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
        --input-bg: var(--vscode-input-background, var(--vscode-editor-background));
        --input-fg: var(--vscode-input-foreground, var(--vscode-foreground));
        --input-border: var(--vscode-input-border, var(--vscode-focusBorder));
        --code-bg: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.12));
        --link: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
        --focus: var(--vscode-focusBorder, #409eff);
        --warning: var(--vscode-editorWarning-foreground, #b89500);
        --error: var(--vscode-editorError-foreground, #d14d41);
      }
      * {
        box-sizing: border-box;
      }
      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        margin: 0;
        padding: 20px;
        line-height: 1.5;
        background: var(--page-bg);
        color: var(--text-main);
      }
      h1, h2 {
        margin: 0 0 12px;
        color: var(--text-main);
      }
      h1 {
        font-size: 24px;
      }
      h2 {
        margin-top: 24px;
        font-size: 18px;
      }
      .app {
        max-width: 1280px;
        margin: 0 auto;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 16px;
      }
      button {
        border: 1px solid var(--panel-border);
        border-radius: 8px;
        padding: 8px 12px;
        background: var(--button-bg);
        color: var(--button-fg);
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
      }
      .icon-button {
        min-width: 56px;
        padding: 6px 10px;
        font-size: 12px;
      }
      button:hover:not(:disabled) {
        background: var(--button-hover);
      }
      button:disabled {
        cursor: default;
        opacity: 0.55;
      }
      button:focus-visible,
      select:focus-visible,
      input:focus-visible {
        outline: 1px solid var(--focus);
        outline-offset: 2px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .card {
        border: 1px solid var(--panel-border);
        border-radius: 12px;
        padding: 14px;
        background: var(--panel-bg);
        box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
      }
      .label {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 4px;
      }
      .value {
        font-size: 15px;
        word-break: break-all;
      }
      .notice {
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
        border: 1px solid var(--panel-border);
        background: var(--panel-bg-elevated);
      }
      .notice.warning {
        border-color: color-mix(in srgb, var(--warning) 45%, transparent);
        background: color-mix(in srgb, var(--warning) 12%, var(--panel-bg-elevated));
      }
      .notice.error {
        border-color: color-mix(in srgb, var(--error) 45%, transparent);
        background: color-mix(in srgb, var(--error) 12%, var(--panel-bg-elevated));
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--panel-border);
        border-radius: 12px;
        background: var(--panel-bg);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--panel-border);
        vertical-align: top;
      }
      th {
        color: var(--text-muted);
        font-weight: 600;
        background: color-mix(in srgb, var(--panel-bg) 86%, var(--page-bg));
      }
      tr:hover td {
        background: color-mix(in srgb, var(--panel-bg-elevated) 75%, var(--focus) 6%);
      }
      tr.session-detail-row:hover td {
        background: transparent;
      }
      .muted {
        color: var(--text-muted);
      }
      .detail-panel {
        border-top: 1px dashed var(--panel-border);
        padding-top: 12px;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
      }
      .detail-card {
        border: 1px solid var(--panel-border);
        border-radius: 10px;
        padding: 12px;
        background: var(--panel-bg-elevated);
      }
      .detail-card h3 {
        margin: 0 0 10px;
        font-size: 14px;
      }
      .message-list,
      .event-list {
        display: grid;
        gap: 8px;
        max-height: 420px;
        overflow: auto;
      }
      .message-item,
      .event-item {
        border: 1px solid var(--panel-border);
        border-radius: 8px;
        padding: 10px;
        background: var(--panel-bg);
      }
      .message-meta,
      .event-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 6px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .message-role {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-bg-elevated) 90%, var(--focus) 10%);
        color: var(--text-main);
      }
      .message-text,
      .event-body {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .detail-summary {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 12px;
        color: var(--text-muted);
        font-size: 12px;
      }
      .controls {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px 16px;
        margin-top: 10px;
      }
      .control {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text-main);
      }
      select {
        border: 1px solid var(--input-border);
        border-radius: 8px;
        padding: 6px 10px;
        background: var(--input-bg);
        color: var(--input-fg);
      }
      input[type="checkbox"] {
        accent-color: var(--link);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        background: var(--code-bg);
        border-radius: 6px;
        padding: 1px 6px;
      }
      @supports not (background: color-mix(in srgb, white 50%, black)) {
        .notice.warning {
          background: rgba(255, 196, 0, 0.12);
        }
        .notice.error {
          background: rgba(255, 76, 76, 0.12);
        }
        th {
          background: rgba(127, 127, 127, 0.08);
        }
        tr:hover td {
          background: rgba(127, 127, 127, 0.06);
        }
      }
      @media (max-width: 720px) {
        body {
          padding: 14px;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        .toolbar {
          gap: 6px;
        }
        button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <h1>${ui.dashboardTitle}</h1>
      <div class="toolbar">
        <button data-action="start">${ui.dashboardStart}</button>
        <button data-action="stop">${ui.dashboardStop}</button>
        <button data-action="refresh">${ui.dashboardRefresh}</button>
        <button data-action="copy-address">${ui.dashboardCopyBaseUrl}</button>
        <button data-action="sync-ag-sessions">${ui.dashboardSyncAgSessions}</button>
        <button data-action="open-health">${ui.dashboardOpenHealth}</button>
        <button data-action="open-status">${ui.dashboardOpenStatus}</button>
      </div>
      ${portNotice}
      ${errorNotice}
      <div class="grid">
        <div class="card">
          <div class="label">${ui.dashboardRunState}</div>
          <div class="value">${status.running ? ui.dashboardRunning : ui.dashboardStopped}</div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardAddress}</div>
          <div class="value">${escapeHtml(status.address ?? ui.dashboardNotStarted)}</div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardPort}</div>
          <div class="value">${ui.dashboardPortValue(status.requestedPort, status.actualPort ?? ui.dashboardNotStarted)}</div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardDataDir}</div>
          <div class="value"><code>${escapeHtml(status.dataDir)}</code></div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardWorkspace}</div>
          <div class="value"><code>${escapeHtml(workspacePath)}</code></div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardSessionStats}</div>
          <div class="value">${ui.dashboardSessionStatsValue(status.sessionCount, status.liveSessionCount, status.persistedSessionCount)}</div>
        </div>
        <div class="card">
          <div class="label">${ui.dashboardExtensionVersion}</div>
          <div class="value">${escapeHtml(extensionVersion)}</div>
        </div>
      </div>
      <h2>${ui.dashboardAutoApproval}</h2>
      <div class="card">
        <div class="label">${ui.dashboardAutoApprovalSubtitle}</div>
        <div class="controls">
          <label class="control"><input id="auto-enabled" type="checkbox" ${autoApprovalSettings.enabled ? "checked" : ""} />${ui.dashboardEnableAutoApproval}</label>
          <label class="control"><input id="auto-run-commands" type="checkbox" ${autoApprovalSettings.runCommands ? "checked" : ""} />${ui.dashboardAutoRunCommands}</label>
          <label class="control"><input id="auto-file-permissions" type="checkbox" ${autoApprovalSettings.filePermissions ? "checked" : ""} />${ui.dashboardAutoFilePermissions}</label>
          <label class="control"><input id="auto-open-browser" type="checkbox" ${autoApprovalSettings.openBrowser ? "checked" : ""} />${ui.dashboardAutoOpenBrowser}</label>
          <label class="control"><input id="auto-browser-actions" type="checkbox" ${autoApprovalSettings.browserActions ? "checked" : ""} />${ui.dashboardAutoBrowserActions}</label>
          <label class="control"><input id="auto-send-command-input" type="checkbox" ${autoApprovalSettings.sendCommandInput ? "checked" : ""} />${ui.dashboardAutoSendCommandInput}</label>
          <label class="control">${ui.dashboardFilePermissionScope}
            <select id="auto-file-scope">
              <option value="once" ${autoApprovalSettings.filePermissionScope === "once" ? "selected" : ""}>once</option>
              <option value="conversation" ${autoApprovalSettings.filePermissionScope === "conversation" ? "selected" : ""}>conversation</option>
            </select>
          </label>
        </div>
        <div class="toolbar" style="margin-top: 12px; margin-bottom: 0;">
          <button data-action="save-auto-approval">${ui.dashboardSaveAutoApproval}</button>
        </div>
      </div>
      <h2>${ui.dashboardSessions}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>${ui.dashboardAction}</th>
              <th>ID</th>
              <th>${ui.dashboardTitleLabel}</th>
              <th>${ui.dashboardState}</th>
              <th>${ui.dashboardMode}</th>
              <th>${ui.dashboardRunStatus}</th>
              <th>${ui.dashboardMessages}</th>
              <th>${ui.dashboardSteps}</th>
              <th>${ui.dashboardPreview}</th>
            </tr>
          </thead>
          <tbody>${sessionRows}</tbody>
        </table>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      for (const button of document.querySelectorAll("button[data-action]")) {
        button.addEventListener("click", () => {
          if (button.dataset.action === "save-auto-approval") {
            vscode.postMessage({
              type: "save-auto-approval",
              settings: {
                enabled: document.getElementById("auto-enabled").checked,
                runCommands: document.getElementById("auto-run-commands").checked,
                filePermissions: document.getElementById("auto-file-permissions").checked,
                filePermissionScope: document.getElementById("auto-file-scope").value,
                openBrowser: document.getElementById("auto-open-browser").checked,
                browserActions: document.getElementById("auto-browser-actions").checked,
                sendCommandInput: document.getElementById("auto-send-command-input").checked,
              },
            });
            return;
          }
          vscode.postMessage({ type: button.dataset.action, sessionId: button.dataset.sessionId });
        });
      }
    </script>
  </body>
</html>`;
}

function renderSessionDetails(exported: SessionExport | undefined, session: SessionSnapshot, ui: UiCopy): string {
  if (!exported) {
    return `
      <tr class="session-detail-row">
        <td colspan="9">
          <div class="detail-panel muted">${ui.detailUnavailable}</div>
        </td>
      </tr>`;
  }

  const transcript = extractTranscriptEntries(exported.events, ui);
  const transcriptHtml =
    transcript.length === 0
      ? `<div class="muted">${ui.detailNoTranscript}</div>`
      : transcript
          .map(
            (entry) => `
              <div class="message-item">
                <div class="message-meta">
                  <span class="message-role">${escapeHtml(entry.role)}</span>
                  <span>${escapeHtml(entry.label)}</span>
                  <span>${escapeHtml(entry.timestamp)}</span>
                  ${entry.stepIndex !== undefined ? `<span>step #${entry.stepIndex}</span>` : ""}
                </div>
                <div class="message-text">${escapeHtml(entry.text)}</div>
              </div>`,
          )
          .join("");

  const eventsHtml =
    exported.events.length === 0
      ? `<div class="muted">${ui.detailNoEvents}</div>`
      : exported.events
          .map(
            (event) => `
              <div class="event-item">
                <div class="event-meta">
                  <span>#${event.seq}</span>
                  <span>${escapeHtml(event.type)}</span>
                  <span>${escapeHtml(event.timestamp)}</span>
                </div>
                <div class="event-body">${escapeHtml(JSON.stringify(event.data, null, 2))}</div>
              </div>`,
          )
          .join("");

  return `
    <tr class="session-detail-row">
      <td colspan="9">
        <div class="detail-panel">
          <div class="detail-summary">
            <span>session: <code>${escapeHtml(session.id)}</code></span>
            <span>cascade: <code>${escapeHtml(session.cascadeId)}</code></span>
            <span>${ui.detailMessageCount}: ${transcript.length}</span>
            <span>${ui.detailEventCount}: ${exported.events.length}</span>
          </div>
          <div class="detail-grid">
            <div class="detail-card">
              <h3>${ui.detailMessagesView}</h3>
              <div class="message-list">${transcriptHtml}</div>
            </div>
            <div class="detail-card">
              <h3>${ui.detailFullEvents}</h3>
              <div class="event-list">${eventsHtml}</div>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}

function extractTranscriptEntries(events: BridgeEvent[], ui: UiCopy): Array<{
  role: string;
  label: string;
  text: string;
  timestamp: string;
  stepIndex?: number;
}> {
  const entries: Array<{
    role: string;
    label: string;
    text: string;
    timestamp: string;
    stepIndex?: number;
  }> = [];

  const matchedBridgeSent = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "cascade.user_input") {
      continue;
    }
    const text = readEventText(event);
    if (!text) {
      continue;
    }
    const matchedIndex = findMatchingSentEvent(events, index, text, matchedBridgeSent);
    if (matchedIndex !== undefined) {
      matchedBridgeSent.add(matchedIndex);
    }
    entries.push({
      role: ui.transcriptUser,
      label: matchedIndex !== undefined ? ui.transcriptBridgeObserved : ui.transcriptObserved,
      text,
      timestamp: event.timestamp,
      stepIndex: readStepIndex(event),
    });
  }

  const assistantByStep = new Map<number, { text: string; timestamp: string; firstSeq: number }>();
  for (const event of events) {
    if (event.type === "message.sent") {
      const text = readEventText(event);
      if (!text) {
        continue;
      }
      const seqIndex = event.seq;
      if (!matchedBridgeSent.has(seqIndex)) {
        entries.push({
          role: ui.transcriptUser,
          label: ui.transcriptBridge,
          text,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type !== "cascade.text.delta") {
      continue;
    }

    const stepIndex = readStepIndex(event);
    if (stepIndex === undefined) {
      continue;
    }
    const text = readEventFullText(event);
    if (!text) {
      continue;
    }

    const current = assistantByStep.get(stepIndex);
    if (!current) {
      assistantByStep.set(stepIndex, {
        text,
        timestamp: event.timestamp,
        firstSeq: event.seq,
      });
    } else {
      current.text = text;
      current.timestamp = event.timestamp;
    }
  }

  for (const [stepIndex, value] of assistantByStep.entries()) {
    entries.push({
      role: ui.transcriptAssistant,
      label: ui.transcriptReply,
      text: value.text,
      timestamp: value.timestamp,
      stepIndex,
    });
  }

  return entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function findMatchingSentEvent(
  events: BridgeEvent[],
  userInputIndex: number,
  text: string,
  matchedBridgeSent: Set<number>,
): number | undefined {
  for (let index = Math.max(0, userInputIndex - 6); index < userInputIndex; index += 1) {
    const event = events[index];
    if (event.type !== "message.sent" || matchedBridgeSent.has(event.seq)) {
      continue;
    }
    if (readEventText(event) !== text) {
      continue;
    }
    return event.seq;
  }
  return undefined;
}

function readEventText(event: BridgeEvent): string {
  const data = event.data as Record<string, unknown>;
  if (typeof data.text === "string") {
    return data.text;
  }
  if (typeof data.query === "string" && data.query) {
    return data.query;
  }
  if (typeof data.userResponse === "string" && data.userResponse) {
    return data.userResponse;
  }
  return "";
}

function readEventFullText(event: BridgeEvent): string {
  const data = event.data as Record<string, unknown>;
  return typeof data.fullText === "string" ? data.fullText : "";
}

function readStepIndex(event: BridgeEvent): number | undefined {
  const data = event.data as Record<string, unknown>;
  return typeof data.stepIndex === "number" ? data.stepIndex : undefined;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

interface UiCopy {
  htmlLang: string;
  dashboardTitle: string;
  outputStarted: string;
  outputPortSwitched(requestedPort: number, actualPort?: number): string;
  outputStartFailed: string;
  outputStopped: string;
  outputReadSessionDetailFailed(sessionId: string, message: string): string;
  syncRequiresRunning: string;
  syncFinished(discovered: number, attached: number): string;
  autoApprovalSaved: string;
  startFailedMessage(message: string): string;
  copyAddressUnavailable: string;
  copyAddressDone(address: string): string;
  statusBarRunning(address: string): string;
  statusBarStoppedText: string;
  statusBarStoppedTooltip: string;
  statusBarStartFailed(message: string): string;
  workspaceNotDetected: string;
  commandStartedWithPortSwitch(requestedPort: number, actualPort?: number): string;
  commandStarted: string;
  commandStopped: string;
  dashboardPortNotice(requestedPort: number, actualPort?: number): string;
  dashboardLastStartFailed: string;
  dashboardNoSessions: string;
  dashboardCollapse: string;
  dashboardExpand: string;
  dashboardStart: string;
  dashboardStop: string;
  dashboardRefresh: string;
  dashboardCopyBaseUrl: string;
  dashboardSyncAgSessions: string;
  dashboardOpenHealth: string;
  dashboardOpenStatus: string;
  dashboardRunState: string;
  dashboardRunning: string;
  dashboardStopped: string;
  dashboardAddress: string;
  dashboardNotStarted: string;
  dashboardPort: string;
  dashboardPortValue(requestedPort: number, actualPort: number | string): string;
  dashboardDataDir: string;
  dashboardWorkspace: string;
  dashboardSessionStats: string;
  dashboardSessionStatsValue(total: number, live: number, persisted: number): string;
  dashboardExtensionVersion: string;
  dashboardAutoApproval: string;
  dashboardAutoApprovalSubtitle: string;
  dashboardEnableAutoApproval: string;
  dashboardAutoRunCommands: string;
  dashboardAutoFilePermissions: string;
  dashboardAutoOpenBrowser: string;
  dashboardAutoBrowserActions: string;
  dashboardAutoSendCommandInput: string;
  dashboardFilePermissionScope: string;
  dashboardSaveAutoApproval: string;
  dashboardSessions: string;
  dashboardAction: string;
  dashboardTitleLabel: string;
  dashboardState: string;
  dashboardMode: string;
  dashboardRunStatus: string;
  dashboardMessages: string;
  dashboardSteps: string;
  dashboardPreview: string;
  detailUnavailable: string;
  detailNoTranscript: string;
  detailNoEvents: string;
  detailMessageCount: string;
  detailEventCount: string;
  detailMessagesView: string;
  detailFullEvents: string;
  transcriptUser: string;
  transcriptAssistant: string;
  transcriptBridgeObserved: string;
  transcriptObserved: string;
  transcriptBridge: string;
  transcriptReply: string;
}

function getUiCopy(language: string | undefined): UiCopy {
  const isZh = (language ?? "").toLowerCase().startsWith("zh");
  if (isZh) {
    return {
      htmlLang: "zh-CN",
      dashboardTitle: "AG Bridge 状态",
      outputStarted: "服务已启动",
      outputPortSwitched: (requestedPort, actualPort) => `默认端口 ${requestedPort} 被占用，切换到 ${actualPort}`,
      outputStartFailed: "启动失败",
      outputStopped: "服务已停止",
      outputReadSessionDetailFailed: (sessionId, message) => `读取 session 详情失败: ${sessionId} -> ${message}`,
      syncRequiresRunning: "AG Bridge 尚未启动，无法同步 AG sessions。",
      syncFinished: (discovered, attached) => `已同步 ${discovered} 个 AG session，当前附加 ${attached} 个。`,
      autoApprovalSaved: "自动审批设置已更新。",
      startFailedMessage: (message) => `AG Bridge 启动失败: ${message}`,
      copyAddressUnavailable: "AG Bridge 尚未启动，当前没有可复制的 base URL。",
      copyAddressDone: (address) => `已复制 base URL: ${address}`,
      statusBarRunning: (address) => `AG Bridge 已启动: ${address}`,
      statusBarStoppedText: "$(debug-disconnect) AG Bridge 未启动",
      statusBarStoppedTooltip: "AG Bridge 未启动",
      statusBarStartFailed: (message) => `启动失败: ${message}`,
      workspaceNotDetected: "未检测到工作区",
      commandStartedWithPortSwitch: (requestedPort, actualPort) => `AG Bridge 已启动，默认端口 ${requestedPort} 被占用，当前使用 ${actualPort}。`,
      commandStarted: "AG Bridge 已启动。",
      commandStopped: "AG Bridge 已停止。",
      dashboardPortNotice: (requestedPort, actualPort) => `默认端口 <code>${requestedPort}</code> 已占用，当前实际端口是 <code>${actualPort}</code>。`,
      dashboardLastStartFailed: "最近一次启动失败",
      dashboardNoSessions: "当前还没有 session。",
      dashboardCollapse: "收起",
      dashboardExpand: "展开",
      dashboardStart: "启动服务",
      dashboardStop: "停止服务",
      dashboardRefresh: "刷新",
      dashboardCopyBaseUrl: "复制 Base URL",
      dashboardSyncAgSessions: "同步 AG Sessions",
      dashboardOpenHealth: "打开 /health",
      dashboardOpenStatus: "打开 /status",
      dashboardRunState: "运行状态",
      dashboardRunning: "running",
      dashboardStopped: "stopped",
      dashboardAddress: "监听地址",
      dashboardNotStarted: "(未启动)",
      dashboardPort: "端口",
      dashboardPortValue: (requestedPort, actualPort) => `请求 ${requestedPort} / 实际 ${actualPort}`,
      dashboardDataDir: "数据目录",
      dashboardWorkspace: "工作区",
      dashboardSessionStats: "Session 统计",
      dashboardSessionStatsValue: (total, live, persisted) => `总计 ${total} / live ${live} / 持久化 ${persisted}`,
      dashboardExtensionVersion: "扩展版本",
      dashboardAutoApproval: "自动审批",
      dashboardAutoApprovalSubtitle: "服务级自动 accept / allow",
      dashboardEnableAutoApproval: "启用自动审批",
      dashboardAutoRunCommands: "自动接受命令执行",
      dashboardAutoFilePermissions: "自动允许文件权限",
      dashboardAutoOpenBrowser: "自动允许打开浏览器",
      dashboardAutoBrowserActions: "自动允许浏览器操作",
      dashboardAutoSendCommandInput: "自动允许命令输入",
      dashboardFilePermissionScope: "文件权限范围",
      dashboardSaveAutoApproval: "保存自动审批设置",
      dashboardSessions: "Sessions",
      dashboardAction: "操作",
      dashboardTitleLabel: "标题",
      dashboardState: "状态",
      dashboardMode: "模式",
      dashboardRunStatus: "运行态",
      dashboardMessages: "消息",
      dashboardSteps: "步骤",
      dashboardPreview: "预览",
      detailUnavailable: "暂时无法读取这个 session 的详情。",
      detailNoTranscript: "当前还没有可整理的消息内容。",
      detailNoEvents: "当前还没有记录到 event。",
      detailMessageCount: "消息条数",
      detailEventCount: "event 条数",
      detailMessagesView: "消息视图",
      detailFullEvents: "完整 Events",
      transcriptUser: "user",
      transcriptAssistant: "assistant",
      transcriptBridgeObserved: "bridge / observed",
      transcriptObserved: "observed",
      transcriptBridge: "bridge",
      transcriptReply: "reply",
    };
  }

  return {
    htmlLang: "en",
    dashboardTitle: "AG Bridge Dashboard",
    outputStarted: "Service started",
    outputPortSwitched: (requestedPort, actualPort) => `Default port ${requestedPort} was busy, switched to ${actualPort}`,
    outputStartFailed: "Start failed",
    outputStopped: "Service stopped",
    outputReadSessionDetailFailed: (sessionId, message) => `Failed to read session details: ${sessionId} -> ${message}`,
    syncRequiresRunning: "AG Bridge is not running, so AG sessions cannot be synced yet.",
    syncFinished: (discovered, attached) => `Synced ${discovered} AG sessions and attached ${attached} of them.`,
    autoApprovalSaved: "Auto-approval settings updated.",
    startFailedMessage: (message) => `AG Bridge failed to start: ${message}`,
    copyAddressUnavailable: "AG Bridge is not running, so there is no base URL to copy.",
    copyAddressDone: (address) => `Copied base URL: ${address}`,
    statusBarRunning: (address) => `AG Bridge is running: ${address}`,
    statusBarStoppedText: "$(debug-disconnect) AG Bridge stopped",
    statusBarStoppedTooltip: "AG Bridge is not running",
    statusBarStartFailed: (message) => `Start failed: ${message}`,
    workspaceNotDetected: "No workspace detected",
    commandStartedWithPortSwitch: (requestedPort, actualPort) => `AG Bridge started, but default port ${requestedPort} was busy, so it switched to ${actualPort}.`,
    commandStarted: "AG Bridge started.",
    commandStopped: "AG Bridge stopped.",
    dashboardPortNotice: (requestedPort, actualPort) => `Default port <code>${requestedPort}</code> was busy. The active port is <code>${actualPort}</code>.`,
    dashboardLastStartFailed: "Last startup failed",
    dashboardNoSessions: "No sessions yet.",
    dashboardCollapse: "Collapse",
    dashboardExpand: "Expand",
    dashboardStart: "Start service",
    dashboardStop: "Stop service",
    dashboardRefresh: "Refresh",
    dashboardCopyBaseUrl: "Copy base URL",
    dashboardSyncAgSessions: "Sync AG sessions",
    dashboardOpenHealth: "Open /health",
    dashboardOpenStatus: "Open /status",
    dashboardRunState: "Run state",
    dashboardRunning: "running",
    dashboardStopped: "stopped",
    dashboardAddress: "Address",
    dashboardNotStarted: "(not started)",
    dashboardPort: "Port",
    dashboardPortValue: (requestedPort, actualPort) => `requested ${requestedPort} / actual ${actualPort}`,
    dashboardDataDir: "Data directory",
    dashboardWorkspace: "Workspace",
    dashboardSessionStats: "Session stats",
    dashboardSessionStatsValue: (total, live, persisted) => `total ${total} / live ${live} / persisted ${persisted}`,
    dashboardExtensionVersion: "Extension version",
    dashboardAutoApproval: "Auto approval",
    dashboardAutoApprovalSubtitle: "Service-level automatic accept / allow settings",
    dashboardEnableAutoApproval: "Enable auto approval",
    dashboardAutoRunCommands: "Auto-accept command execution",
    dashboardAutoFilePermissions: "Auto-allow file permissions",
    dashboardAutoOpenBrowser: "Auto-allow open browser",
    dashboardAutoBrowserActions: "Auto-allow browser actions",
    dashboardAutoSendCommandInput: "Auto-allow command input",
    dashboardFilePermissionScope: "File permission scope",
    dashboardSaveAutoApproval: "Save auto-approval settings",
    dashboardSessions: "Sessions",
    dashboardAction: "Action",
    dashboardTitleLabel: "Title",
    dashboardState: "State",
    dashboardMode: "Mode",
    dashboardRunStatus: "Run status",
    dashboardMessages: "Messages",
    dashboardSteps: "Steps",
    dashboardPreview: "Preview",
    detailUnavailable: "Session details are temporarily unavailable.",
    detailNoTranscript: "No transcript content has been reconstructed yet.",
    detailNoEvents: "No events have been recorded yet.",
    detailMessageCount: "Messages",
    detailEventCount: "Events",
    detailMessagesView: "Message view",
    detailFullEvents: "Full events",
    transcriptUser: "user",
    transcriptAssistant: "assistant",
    transcriptBridgeObserved: "bridge / observed",
    transcriptObserved: "observed",
    transcriptBridge: "bridge",
    transcriptReply: "reply",
  };
}

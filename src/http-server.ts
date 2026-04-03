import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createBridgeDiscoveryPublisher, type BridgeDiscoveryPublisher } from "./discovery.js";
import type { BridgeSession } from "./bridge-session.js";
import { BridgeRuntime } from "./runtime.js";
import type { AutoApprovalSettings, ServerStatus, SessionExport, SessionSnapshot } from "./types.js";

interface HttpServerOptions {
  host?: string;
  port?: number;
  portSearchLimit?: number;
  defaultWorkspacePath?: string;
  dataDir?: string;
}

export class BridgeHttpServer {
  public readonly host: string;
  public readonly requestedPort: number;

  private readonly portSearchLimit: number;
  private readonly runtime: BridgeRuntime;
  private readonly defaultWorkspacePath?: string;
  private server?: Server;
  private actualPort?: number;
  private startedAt?: string;
  private switchedPort = false;
  private discovery?: BridgeDiscoveryPublisher;

  constructor(options: HttpServerOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 9464;
    this.portSearchLimit = Math.max(0, options.portSearchLimit ?? 20);
    this.defaultWorkspacePath = options.defaultWorkspacePath;
    this.runtime = new BridgeRuntime({
      defaultWorkspacePath: options.defaultWorkspacePath,
      dataDir: options.dataDir,
    });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    let lastError: unknown;
    for (let offset = 0; offset <= this.portSearchLimit; offset += 1) {
      const candidatePort = this.requestedPort + offset;
      try {
        const server = await this.listen(candidatePort);
        this.server = server;
        this.actualPort = resolveBoundPort(server, candidatePort);
        this.startedAt = new Date().toISOString();
        this.switchedPort = candidatePort !== this.requestedPort;
        this.discovery = createBridgeDiscoveryPublisher({
          workspacePath: this.defaultWorkspacePath,
          baseUrl: this.address ?? `http://${this.host}:${this.actualPort}`,
          startedAt: this.startedAt,
        });
        this.discovery?.publish();
        return;
      } catch (error) {
        lastError = error;
        if (isAddressInUseError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to start AG Bridge on ${this.host}:${this.requestedPort}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    this.actualPort = undefined;
    this.startedAt = undefined;
    this.switchedPort = false;
    this.discovery?.dispose();
    this.discovery = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  get address(): string | undefined {
    if (!this.actualPort) {
      return undefined;
    }
    return `http://${this.host}:${this.actualPort}`;
  }

  get running(): boolean {
    return !!this.server;
  }

  get dataDir(): string {
    return this.runtime.dataDir;
  }

  getStatus(): ServerStatus {
    return this.runtime.buildServerStatus({
      running: this.running,
      host: this.host,
      requestedPort: this.requestedPort,
      actualPort: this.actualPort,
      address: this.address,
      switchedPort: this.switchedPort,
      startedAt: this.startedAt,
    });
  }

  listSessions(): SessionSnapshot[] {
    return this.runtime.listSessions();
  }

  exportSession(id: string): SessionExport {
    return this.runtime.exportSession(id);
  }

  async discoverAgSessions(workspacePath?: string) {
    return this.runtime.discoverAgSessions(workspacePath);
  }

  async attachAgSession(cascadeId: string, workspacePath?: string): Promise<SessionSnapshot> {
    const session = await this.runtime.attachAgSession(cascadeId, workspacePath);
    return session.getSnapshot();
  }

  async attachAllAgSessions(workspacePath?: string) {
    return this.runtime.attachAllAgSessions(workspacePath);
  }

  getAutoApprovalSettings(): AutoApprovalSettings {
    return this.runtime.getAutoApprovalSettings();
  }

  updateAutoApprovalSettings(next: Partial<AutoApprovalSettings>): AutoApprovalSettings {
    return this.runtime.updateAutoApprovalSettings(next);
  }

  private async listen(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        server.removeListener("listening", onListening);
        server.close();
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.host);
    });

    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const baseUrl = this.address ?? `http://${this.host}:${this.requestedPort}`;
      const url = new URL(req.url ?? "/", baseUrl);
      const path = url.pathname;

      if (method === "GET" && path === "/health") {
        return this.sendJson(res, 200, this.runtime.getHealth());
      }

      if (method === "GET" && path === "/ping") {
        return this.sendJson(res, 200, {
          ok: true,
          address: this.address ?? null,
          workspacePath: this.runtime.defaultWorkspacePath ?? null,
        });
      }

      if (method === "GET" && path === "/status") {
        return this.sendJson(res, 200, this.getStatus());
      }

      if (method === "GET" && path === "/sessions") {
        return this.sendJson(res, 200, { sessions: this.runtime.listSessions() });
      }

      if (method === "GET" && path === "/ag-sessions") {
        const workspacePath = url.searchParams.get("workspacePath") ?? undefined;
        const sessions = await this.runtime.discoverAgSessions(workspacePath);
        return this.sendJson(res, 200, { sessions });
      }

      if (method === "GET" && path === "/models") {
        const workspacePath = url.searchParams.get("workspacePath") ?? undefined;
        const models = await this.runtime.listAvailableModels(workspacePath);
        return this.sendJson(res, 200, { models });
      }

      if (method === "GET" && path === "/auto-approval") {
        return this.sendJson(res, 200, { settings: this.runtime.getAutoApprovalSettings() });
      }

      if (method === "POST" && path === "/auto-approval") {
        const body = await this.readJsonBody(req);
        const settings = this.runtime.updateAutoApprovalSettings(body);
        return this.sendJson(res, 200, { ok: true, settings });
      }

      if (method === "POST" && path === "/ag-sessions/sync") {
        const body = await this.readJsonBody(req);
        const result = await this.runtime.attachAllAgSessions(body.workspacePath);
        return this.sendJson(res, 200, result);
      }

      if (method === "POST" && path === "/sessions") {
        const body = await this.readJsonBody(req);
        const session = await this.runtime.createSession({
          mode: body.mode,
          workspacePath: body.workspacePath,
          model: body.model,
          sessionId: body.sessionId,
        });
        return this.sendJson(res, 201, { session: session.getSnapshot() });
      }

      const sessionIdMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionIdMatch) {
        const session = this.runtime.getSessionSnapshot(decodeURIComponent(sessionIdMatch[1]));
        return this.sendJson(res, 200, { session });
      }

      const sessionResumeMatch = path.match(/^\/sessions\/([^/]+)\/resume$/);
      if (method === "POST" && sessionResumeMatch) {
        const body = await this.readJsonBody(req);
        const session = await this.runtime.resumeSession(
          decodeURIComponent(sessionResumeMatch[1]),
          body.workspacePath,
        );
        return this.sendJson(res, 200, { session: session.getSnapshot() });
      }

      const agSessionAttachMatch = path.match(/^\/ag-sessions\/([^/]+)\/attach$/);
      if (method === "POST" && agSessionAttachMatch) {
        const body = await this.readJsonBody(req);
        const session = await this.runtime.attachAgSession(
          decodeURIComponent(agSessionAttachMatch[1]),
          body.workspacePath,
        );
        return this.sendJson(res, 200, { session: session.getSnapshot() });
      }

      const agSessionMessageMatch = path.match(/^\/ag-sessions\/([^/]+)\/messages$/);
      if (method === "POST" && agSessionMessageMatch) {
        const body = await this.readJsonBody(req);
        if (!body.text || typeof body.text !== "string") {
          return this.sendJson(res, 400, { error: "Field `text` is required." });
        }
        const session = await this.runtime.attachAgSession(
          decodeURIComponent(agSessionMessageMatch[1]),
          body.workspacePath,
        );
        await session.sendMessageWithModel(body.text, body.model);
        return this.sendJson(res, 200, { ok: true, session: session.getSnapshot() });
      }

      if (method === "DELETE" && sessionIdMatch) {
        const deleted = this.runtime.deleteSession(decodeURIComponent(sessionIdMatch[1]));
        return this.sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "Session not found" });
      }

      const sessionExportMatch = path.match(/^\/sessions\/([^/]+)\/export$/);
      if (method === "GET" && sessionExportMatch) {
        const exported = this.runtime.exportSession(decodeURIComponent(sessionExportMatch[1]));
        return this.sendJson(res, 200, exported);
      }

      const sessionEventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
      if (method === "GET" && sessionEventsMatch) {
        const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
        const limit = parseInt(url.searchParams.get("limit") ?? "0", 10) || undefined;
        const result = this.runtime.getSessionEvents(decodeURIComponent(sessionEventsMatch[1]), since, limit);
        return this.sendJson(res, 200, result);
      }

      const sessionStreamMatch = path.match(/^\/sessions\/([^/]+)\/stream$/);
      if (method === "GET" && sessionStreamMatch) {
        const session = this.runtime.getLiveSession(decodeURIComponent(sessionStreamMatch[1]));
        const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
        return this.streamEvents(req, res, session, since);
      }

      const messageMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        const session = this.runtime.getLiveSession(decodeURIComponent(messageMatch[1]));
        const body = await this.readJsonBody(req);
        if (!body.text || typeof body.text !== "string") {
          return this.sendJson(res, 400, { error: "Field `text` is required." });
        }
        await session.sendMessageWithModel(body.text, body.model);
        return this.sendJson(res, 200, { ok: true, session: session.getSnapshot() });
      }

      const cancelMatch = path.match(/^\/sessions\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelMatch) {
        const session = this.runtime.getLiveSession(decodeURIComponent(cancelMatch[1]));
        await session.cancel();
        return this.sendJson(res, 200, { ok: true });
      }

      const approvalMatch = path.match(/^\/sessions\/([^/]+)\/approvals\/(\d+)\/approve$/);
      if (method === "POST" && approvalMatch) {
        const session = this.runtime.getLiveSession(decodeURIComponent(approvalMatch[1]));
        const body = await this.readJsonBody(req);
        const stepIndex = parseInt(approvalMatch[2], 10);
        const scope = body.scope === "conversation" ? "conversation" : "once";
        await session.approve(stepIndex, scope);
        return this.sendJson(res, 200, { ok: true });
      }

      this.sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJson(res, 500, { error: message });
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return {};
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse, session: BridgeSession, since: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);

    this.writeSse(res, "ready", { session: session.getSnapshot() });
    for (const event of session.getEvents(since)) {
      this.writeSse(res, "event", event);
    }

    const onEvent = (event: unknown) => {
      this.writeSse(res, "event", event);
    };

    session.on("event", onEvent);
    const keepAlive = setInterval(() => {
      res.write(": keepalive\n\n");
    }, 15000);

    const cleanup = () => {
      clearInterval(keepAlive);
      session.off("event", onEvent);
      if (!res.writableEnded) {
        res.end();
      }
    };

    req.on("close", cleanup);
  }

  private writeSse(res: ServerResponse, eventName: string, payload: unknown): void {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function isAddressInUseError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as any).code === "EADDRINUSE";
}

function resolveBoundPort(server: Server, fallbackPort: number): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    return fallbackPort;
  }
  return address.port;
}

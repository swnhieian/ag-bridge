import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";

import { BridgeHttpServer } from "./http-server.js";
import type { AgSessionSummary, AvailableModelSummary, BridgeEvent, ServerStatus, SessionExport, SessionSnapshot } from "./types.js";

const DEFAULT_BASE_URL = process.env.AG_BRIDGE_URL ?? "http://127.0.0.1:9464";
let baseUrl = DEFAULT_BASE_URL;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  baseUrl = readFlag(argv, "--base-url") ?? DEFAULT_BASE_URL;
  const filteredArgs = stripFlag(argv, "--base-url");
  const [command, ...rest] = filteredArgs;

  switch (command) {
    case "serve":
      await runServe(rest);
      return;
    case "status":
      await runStatus(rest);
      return;
    case "ag:list":
      await runAgList(rest);
      return;
    case "ag:attach":
      await runAgAttach(rest);
      return;
    case "ag:sync":
      await runAgSync(rest);
      return;
    case "list-models":
      await runListModels(rest);
      return;
    case "session:create":
      await runSessionCreate(rest);
      return;
    case "session:list":
      await runSessionList(rest);
      return;
    case "session:get":
      await runSessionGet(rest);
      return;
    case "send":
      await runSend(rest);
      return;
    case "events":
      await runEvents(rest);
      return;
    case "stream":
      await runStream(rest);
      return;
    case "cancel":
      await runCancel(rest);
      return;
    case "approve":
      await runApprove(rest);
      return;
    case "export":
      await runExport(rest);
      return;
    case "delete":
      await runDelete(rest);
      return;
    case "chat":
      await runChat(rest);
      return;
    case "resume":
      await runResume(rest);
      return;
    case "ask":
      await runAsk(rest);
      return;
    default:
      printHelp();
      process.exitCode = command ? 1 : 0;
  }
}

async function runServe(args: string[]): Promise<void> {
  const port = parseOptionalNumber(readFlag(args, "--port")) ?? 9464;
  const host = readFlag(args, "--host") ?? "127.0.0.1";
  const dataDir = readFlag(args, "--data-dir");

  const server = new BridgeHttpServer({ host, port, dataDir });
  await server.start();

  const status = server.getStatus();
  process.stdout.write(`AG Bridge listening on ${status.address}\n`);
  if (status.switchedPort) {
    process.stdout.write(`Requested port ${status.requestedPort} was busy, switched to ${status.actualPort}\n`);
  }
  process.stdout.write(`Data dir: ${status.dataDir}\n`);
}

async function runStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const status = (await requestJson("GET", "/status")) as ServerStatus;
  const sessions = ((await requestJson("GET", "/sessions")).sessions ?? []) as SessionSnapshot[];

  if (json) {
    process.stdout.write(`${JSON.stringify({ status, sessions }, null, 2)}\n`);
    return;
  }

  printStatusSummary(status);
  process.stdout.write("\n");
  printSessionTable(sessions);
}

async function runAgList(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const workspacePath = readFlag(args, "--workspace");
  const response = await requestJson(
    "GET",
    `/ag-sessions${buildQuery({
      workspacePath,
    })}`,
  );
  const sessions = response.sessions as AgSessionSummary[];
  if (json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  printAgSessionTable(sessions);
}

async function runAgAttach(args: string[]): Promise<void> {
  const cascadeId = requireArg(args[0], "cascade id");
  const workspacePath = readFlag(args.slice(1), "--workspace");
  await runJson("POST", `/ag-sessions/${encodeURIComponent(cascadeId)}/attach`, {
    ...(workspacePath ? { workspacePath } : {}),
  });
}

async function runAgSync(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const workspacePath = readFlag(args, "--workspace");
  const payload = await requestJson("POST", "/ag-sessions/sync", {
    ...(workspacePath ? { workspacePath } : {}),
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `Discovered ${Array.isArray(payload.discovered) ? payload.discovered.length : 0} AG sessions.\n`,
  );
  const attached = (payload.attached ?? []) as SessionSnapshot[];
  if (attached.length === 0) {
    process.stdout.write("No sessions attached.\n");
    return;
  }
  printSessionTable(attached);
}

async function runSessionCreate(args: string[]): Promise<void> {
  const body = {
    mode: readFlag(args, "--mode") ?? "connect",
    workspacePath: readFlag(args, "--workspace"),
    model: readFlag(args, "--model"),
    sessionId: readFlag(args, "--session-id"),
  };
  await runJson("POST", "/sessions", body);
}

async function runListModels(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const workspacePath = readFlag(args, "--workspace");
  const response = await requestJson(
    "GET",
    `/models${buildQuery({
      workspacePath,
    })}`,
  );
  const models = (response.models ?? []) as AvailableModelSummary[];
  if (json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  printModelTable(models);
}

async function runSessionList(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const response = await requestJson("GET", "/sessions");
  const sessions = response.sessions as SessionSnapshot[];
  if (json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  printSessionTable(sessions);
}

async function runSessionGet(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  await runJson("GET", `/sessions/${encodeURIComponent(sessionId)}`);
}

async function runSend(args: string[]): Promise<void> {
  const model = readFlag(args, "--model");
  const createIfMissing = args.includes("--create-if-missing");
  const positionalArgs = stripSwitch(stripFlags(args, "--model"), "--create-if-missing");
  const sessionId = requireArg(positionalArgs[0], "session id");
  const text = requireArg(positionalArgs.slice(1).join(" "), "message text");
  const session = createIfMissing
    ? await resolveSessionSelection({
        sessionId,
        createIfMissing: true,
      })
    : await ensureLiveSession(sessionId);
  await runJson("POST", `/sessions/${encodeURIComponent(session.id)}/messages`, {
    text,
    ...(model ? { model } : {}),
  });
}

async function runEvents(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  const since = parseOptionalNumber(readFlag(args.slice(1), "--since"));
  const limit = parseOptionalNumber(readFlag(args.slice(1), "--limit"));
  const json = args.includes("--json");
  const suffix = buildQuery({
    since: since ? String(since) : undefined,
    limit: limit ? String(limit) : undefined,
  });

  const payload = await requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/events${suffix}`);
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const events = (payload.events ?? []) as BridgeEvent[];
  if (events.length === 0) {
    process.stdout.write("No events.\n");
    return;
  }

  for (const event of events) {
    process.stdout.write(
      `${pad(String(event.seq), 4)}  ${event.timestamp}  ${pad(event.type, 28)}  ${formatEventPreview(event)}\n`,
    );
  }
}

async function runStream(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  const session = await ensureLiveSession(sessionId);
  await streamSession(session.id, {
    showThinking: true,
    showLifecycle: true,
    stopOnApproval: false,
    stopOnDone: false,
  });
}

async function runCancel(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  const session = await ensureLiveSession(sessionId);
  await runJson("POST", `/sessions/${encodeURIComponent(session.id)}/cancel`);
}

async function runApprove(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  const stepIndex = requireArg(args[1], "step index");
  const scope = readFlag(args.slice(2), "--scope") ?? "once";
  const session = await ensureLiveSession(sessionId);
  await runJson("POST", `/sessions/${encodeURIComponent(session.id)}/approvals/${encodeURIComponent(stepIndex)}/approve`, {
    scope,
  });
}

async function runExport(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  await runJson("GET", `/sessions/${encodeURIComponent(sessionId)}/export`);
}

async function runDelete(args: string[]): Promise<void> {
  const sessionId = requireArg(args[0], "session id");
  await runJson("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
}

async function runAsk(args: string[]): Promise<void> {
  const workspacePath = readFlag(args, "--workspace");
  let requestedModel = readFlag(args, "--model");
  const requestedSessionId = readFlag(args, "--session-id");
  const selectedSessionId = readFlag(args, "--session");
  const useLast = args.includes("--last");
  const createIfMissing = args.includes("--create-if-missing");
  const showThinking = readFlag(args, "--thinking") !== "off";

  if (selectedSessionId && useLast) {
    throw new Error("Use either --session or --last, not both.");
  }
  if (selectedSessionId && requestedSessionId) {
    throw new Error("Use either --session or --session-id, not both.");
  }
  if (useLast && requestedSessionId) {
    throw new Error("Use either --last or --session-id, not both.");
  }

  const positionalArgs = stripSwitch(
    stripSwitch(
      stripFlags(args, "--workspace", "--model", "--session-id", "--session", "--thinking"),
      "--create-if-missing",
    ),
    "--last",
  );
  const text = requireArg(positionalArgs.join(" "), "message text");
  let session: SessionSnapshot;

  if (selectedSessionId || useLast) {
    session = await resolveSessionSelection({
      sessionId: selectedSessionId,
      useLast,
      workspacePath,
      requestedModel,
      createIfMissing,
    });
    requestedModel = requestedModel ?? session.requestedModel;
  } else {
    const createResponse = await requestJson("POST", "/sessions", {
      mode: "connect",
      ...(workspacePath ? { workspacePath } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    });
    session = createResponse.session as SessionSnapshot;
  }

  process.stderr.write(`[session] ${session.id} cascade=${session.cascadeId}\n`);
  await executeTurn(session.id, text, { showThinking, requestedModel });
}

async function runChat(args: string[]): Promise<void> {
  const workspacePath = readFlag(args, "--workspace");
  let requestedModel = readFlag(args, "--model");
  const requestedSessionId = readFlag(args, "--session-id");
  const selectedSessionId = readFlag(args, "--session");
  const useLast = args.includes("--last");
  const createIfMissing = args.includes("--create-if-missing");
  const showThinking = readFlag(args, "--thinking") !== "off";

  if (selectedSessionId && useLast) {
    throw new Error("Use either --session or --last, not both.");
  }
  if (selectedSessionId && requestedSessionId) {
    throw new Error("Use either --session or --session-id, not both.");
  }
  if (useLast && requestedSessionId) {
    throw new Error("Use either --last or --session-id, not both.");
  }

  let currentSessionId: string;
  if (selectedSessionId || useLast) {
    const session = await resolveSessionSelection({
      sessionId: selectedSessionId,
      useLast,
      workspacePath,
      requestedModel,
      createIfMissing,
    });
    currentSessionId = session.id;
    requestedModel = requestedModel ?? session.requestedModel;
  } else {
    currentSessionId = await createSession("connect", workspacePath, requestedModel, requestedSessionId);
  }

  await openInteractiveChat({
    currentSessionId,
    workspacePath,
    requestedModel,
    showThinking,
  });
}

async function runResume(args: string[]): Promise<void> {
  const workspacePath = readFlag(args, "--workspace");
  let requestedModel = readFlag(args, "--model");
  const showThinking = readFlag(args, "--thinking") !== "off";
  const useLast = args.includes("--last");
  const createIfMissing = args.includes("--create-if-missing");
  const positionalArgs = stripSwitch(
    stripSwitch(stripFlags(args, "--workspace", "--model", "--thinking"), "--create-if-missing"),
    "--last",
  );
  const requestedSessionId = positionalArgs[0];

  if (requestedSessionId && useLast) {
    throw new Error("Use either <sessionId> or --last, not both.");
  }

  const session = await resolveSessionSelection({
    sessionId: requestedSessionId,
    useLast: useLast || !requestedSessionId,
    workspacePath,
    requestedModel,
    createIfMissing,
  });

  await openInteractiveChat({
    currentSessionId: session.id,
    workspacePath: workspacePath ?? session.workspacePath,
    requestedModel: requestedModel ?? session.requestedModel,
    showThinking,
  });
}

async function openInteractiveChat(
  options: {
    currentSessionId: string;
    workspacePath?: string;
    requestedModel?: string;
    showThinking: boolean;
  },
): Promise<void> {
  let currentSessionId = options.currentSessionId;
  const workspacePath = options.workspacePath;
  let requestedModel = options.requestedModel;
  let showThinking = options.showThinking;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  process.stdout.write("Interactive chat ready. Type /help for commands.\n");
  process.stdout.write(`Current session: ${currentSessionId}\n`);

  while (true) {
    const answer = (await rl.question(`ag:${shortSessionId(currentSessionId)}> `)).trim();
    if (!answer) {
      continue;
    }

    if (answer.startsWith("/")) {
      const shouldExit = await handleSlashCommand(answer, {
        currentSessionId,
        workspacePath,
        setSessionId(value) {
          currentSessionId = value;
        },
        showThinking,
        setShowThinking(value) {
          showThinking = value;
        },
        requestedModel,
        setRequestedModel(value) {
          requestedModel = value;
        },
      });
      if (shouldExit) {
        break;
      }
      continue;
    }

    await executeTurn(currentSessionId, answer, {
      showThinking,
      requestedModel,
    });
  }

  rl.close();
}

async function handleSlashCommand(
  answer: string,
  context: {
    currentSessionId: string;
    workspacePath?: string;
    setSessionId: (value: string) => void;
    showThinking: boolean;
    setShowThinking: (value: boolean) => void;
    requestedModel?: string;
    setRequestedModel: (value: string | undefined) => void;
  },
): Promise<boolean> {
  const [command, ...rest] = answer.slice(1).split(/\s+/);

  switch (command) {
    case "help":
      process.stdout.write(helpForChat());
      return false;
    case "new": {
      const mode = rest[0] === "launch" ? "launch" : "connect";
      const workspace = rest[1] ?? context.workspacePath;
      const requestedModel = rest[2] ?? context.requestedModel;
      const requestedSessionId = rest[3];
      const sessionId = await createSession(mode, workspace, requestedModel, requestedSessionId);
      context.setSessionId(sessionId);
      context.setRequestedModel(requestedModel);
      process.stdout.write(`Switched to ${sessionId}\n`);
      return false;
    }
    case "use": {
      const sessionId = requireArg(rest[0], "session id");
      const snapshot = await resolveSessionSelection({
        sessionId,
        workspacePath: context.workspacePath,
        requestedModel: context.requestedModel,
        createIfMissing: true,
      });
      context.setSessionId(snapshot.id);
      context.setRequestedModel(snapshot.requestedModel);
      process.stdout.write(`Switched to ${sessionId}\n`);
      return false;
    }
    case "resume": {
      const snapshot = await resolveSessionSelection({
        sessionId: rest[0] === "last" ? undefined : rest[0],
        useLast: !rest[0] || rest[0] === "last",
      });
      context.setSessionId(snapshot.id);
      context.setRequestedModel(snapshot.requestedModel);
      process.stdout.write(`Switched to ${snapshot.id}\n`);
      return false;
    }
    case "sessions": {
      const response = await requestJson("GET", "/sessions");
      printSessionTable(response.sessions as SessionSnapshot[]);
      return false;
    }
    case "ag-sessions": {
      const response = await requestJson("GET", "/ag-sessions");
      printAgSessionTable(response.sessions as AgSessionSummary[]);
      return false;
    }
    case "sync": {
      const payload = await requestJson("POST", "/ag-sessions/sync");
      const attached = (payload.attached ?? []) as SessionSnapshot[];
      process.stdout.write(
        `Synced ${Array.isArray(payload.discovered) ? payload.discovered.length : 0} AG sessions.\n`,
      );
      if (attached.length > 0) {
        printSessionTable(attached);
      }
      return false;
    }
    case "attach": {
      const cascadeId = requireArg(rest[0], "cascade id");
      const payload = await requestJson("POST", `/ag-sessions/${encodeURIComponent(cascadeId)}/attach`);
      process.stdout.write(`Attached ${((payload.session as SessionSnapshot) ?? { id: "" }).id}\n`);
      return false;
    }
    case "status": {
      await runStatus([]);
      return false;
    }
    case "events": {
      const limit = parseOptionalNumber(rest[0]) ?? 20;
      const payload = await requestJson(
        "GET",
        `/sessions/${encodeURIComponent(context.currentSessionId)}/events${buildQuery({ limit: String(limit) })}`,
      );
      const events = payload.events as BridgeEvent[];
      for (const event of events) {
        process.stdout.write(
          `${pad(String(event.seq), 4)}  ${event.timestamp}  ${pad(event.type, 28)}  ${formatEventPreview(event)}\n`,
        );
      }
      return false;
    }
    case "export": {
      const exported = (await requestJson(
        "GET",
        `/sessions/${encodeURIComponent(context.currentSessionId)}/export`,
      )) as SessionExport;
      process.stdout.write(`${JSON.stringify(exported, null, 2)}\n`);
      return false;
    }
    case "approve": {
      const stepIndex = requireArg(rest[0], "step index");
      const scope = rest[1] === "conversation" ? "conversation" : "once";
      await requestJson(
        "POST",
        `/sessions/${encodeURIComponent(context.currentSessionId)}/approvals/${encodeURIComponent(stepIndex)}/approve`,
        { scope },
      );
      process.stdout.write(`Approved step ${stepIndex} (${scope})\n`);
      return false;
    }
    case "cancel":
      await requestJson("POST", `/sessions/${encodeURIComponent(context.currentSessionId)}/cancel`);
      process.stdout.write("Cancel requested.\n");
      return false;
    case "thinking":
      if (rest[0] === "off") {
        context.setShowThinking(false);
        process.stdout.write("Thinking output hidden.\n");
        return false;
      }
      context.setShowThinking(true);
      process.stdout.write("Thinking output enabled.\n");
      return false;
    case "quit":
    case "exit":
      return true;
    default:
      process.stdout.write(`Unknown command: /${command}\n`);
      process.stdout.write(helpForChat());
      return false;
  }
}

async function executeTurn(
  sessionId: string,
  text: string,
  options: {
    showThinking: boolean;
    requestedModel?: string;
  },
): Promise<void> {
  const snapshot = await ensureLiveSession(sessionId);
  const activeSessionId = snapshot.id;
  const since = snapshot.eventCount;

  const streamPromise = streamSession(activeSessionId, {
    since,
    showThinking: options.showThinking,
    showLifecycle: true,
    stopOnApproval: true,
    stopOnDone: true,
  });

  await requestJson("POST", `/sessions/${encodeURIComponent(activeSessionId)}/messages`, {
    text,
    ...(options.requestedModel ? { model: options.requestedModel } : {}),
  });
  const result = await streamPromise;

  if (result === "approval") {
    process.stdout.write("\nTurn paused waiting for approval. Use /approve <stepIndex> [scope].\n");
  } else {
    process.stdout.write("\n");
  }
}

async function streamSession(
  sessionId: string,
  options: {
    since?: number;
    showThinking: boolean;
    showLifecycle: boolean;
    stopOnApproval: boolean;
    stopOnDone: boolean;
  },
): Promise<"done" | "approval" | "error" | "closed"> {
  const controller = new AbortController();
  let state: "done" | "approval" | "error" | "closed" = "closed";

  await consumeEventStream(
    `/sessions/${encodeURIComponent(sessionId)}/stream${buildQuery({
      since: options.since ? String(options.since) : undefined,
    })}`,
    async (eventName, payload) => {
      if (eventName === "ready") {
        if (options.showLifecycle) {
          process.stderr.write(`[ready] ${payload.session.id} cascade=${payload.session.cascadeId}\n`);
        }
        return false;
      }

      if (eventName !== "event") {
        return false;
      }

      const event = payload as BridgeEvent;
      const data = event.data as Record<string, unknown>;

      switch (event.type) {
        case "cascade.status":
          if (options.showLifecycle) {
            process.stderr.write(`[status] ${String(data.previousStatus)} -> ${String(data.status)}\n`);
          }
          break;
        case "cascade.step.new":
          if (options.showLifecycle) {
            process.stderr.write(
              `[step] #${String(data.stepIndex)} ${String(data.stepType)} ${String(data.description)}\n`,
            );
          }
          break;
        case "cascade.step.updated":
          if (options.showLifecycle) {
            process.stderr.write(
              `[step:update] #${String(data.stepIndex)} ${String(data.previousStatus)} -> ${String(data.status)}\n`,
            );
          }
          break;
        case "cascade.thinking.delta":
          if (options.showThinking) {
            process.stderr.write(String(data.delta));
          }
          break;
        case "cascade.command.output": {
          const stream = String(data.stream);
          const out = stream === "stderr" ? process.stderr : process.stdout;
          out.write(String(data.delta));
          break;
        }
        case "cascade.approval.needed":
          process.stderr.write(
            `\n[approval] step=${String(data.stepIndex)} type=${String(data.approvalType)} ${String(data.description)}\n`,
          );
          if (options.stopOnApproval) {
            state = "approval";
            controller.abort();
            return true;
          }
          break;
        case "cascade.text.delta":
          process.stdout.write(String(data.delta));
          break;
        case "cascade.done":
          state = "done";
          if (options.stopOnDone) {
            controller.abort();
            return true;
          }
          break;
        case "cascade.error":
          process.stderr.write(`\n[error] ${String(data.message)}\n`);
          state = "error";
          controller.abort();
          return true;
        default:
          break;
      }

      return false;
    },
    controller.signal,
  );

  return state;
}

async function runJson(method: string, path: string, body?: unknown): Promise<void> {
  const payload = await requestJson(method, path, body);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function requestJson(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(parsed.error || `HTTP ${response.status}`);
  }
  return parsed;
}

async function createSession(
  mode: "connect" | "launch",
  workspacePath?: string,
  requestedModel?: string,
  sessionId?: string,
): Promise<string> {
  const session = await createSessionSnapshot(mode, workspacePath, requestedModel, sessionId);
  return session.id;
}

async function createSessionSnapshot(
  mode: "connect" | "launch",
  workspacePath?: string,
  requestedModel?: string,
  sessionId?: string,
): Promise<SessionSnapshot> {
  const payload = await requestJson("POST", "/sessions", {
    mode,
    ...(workspacePath ? { workspacePath } : {}),
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
  return payload.session as SessionSnapshot;
}

async function getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
  const payload = await requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  return payload.session as SessionSnapshot;
}

async function getLastSessionSnapshot(): Promise<SessionSnapshot> {
  const payload = await requestJson("GET", "/sessions");
  const sessions = (payload.sessions ?? []) as SessionSnapshot[];
  const latest = sessions[0];
  if (!latest) {
    throw new Error("No sessions available.");
  }
  return latest;
}

async function resumeSessionById(sessionId: string): Promise<SessionSnapshot> {
  const payload = await requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/resume`);
  return payload.session as SessionSnapshot;
}

async function resumeSessionByIdWithWorkspace(sessionId: string, workspacePath?: string): Promise<SessionSnapshot> {
  if (!workspacePath) {
    return resumeSessionById(sessionId);
  }
  const payload = await requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/resume`, {
    workspacePath,
  });
  return payload.session as SessionSnapshot;
}

async function ensureLiveSession(sessionOrId: string | SessionSnapshot, workspacePath?: string): Promise<SessionSnapshot> {
  const snapshot = typeof sessionOrId === "string" ? await getSessionSnapshot(sessionOrId) : sessionOrId;
  if (snapshot.live) {
    return snapshot;
  }
  return resumeSessionByIdWithWorkspace(snapshot.id, workspacePath);
}

async function resolveSessionSelection(options: {
  sessionId?: string;
  useLast?: boolean;
  workspacePath?: string;
  requestedModel?: string;
  createIfMissing?: boolean;
}): Promise<SessionSnapshot> {
  if (options.sessionId && options.useLast) {
    throw new Error("Use either a session id or --last, not both.");
  }
  let snapshot: SessionSnapshot;
  if (options.sessionId) {
    try {
      snapshot = await getSessionSnapshot(options.sessionId);
    } catch (error) {
      if (!options.createIfMissing || !isSessionNotFoundError(error)) {
        throw error;
      }
      snapshot = await createSessionSnapshot("connect", options.workspacePath, options.requestedModel, options.sessionId);
    }
  } else {
    snapshot = await getLastSessionSnapshot();
  }
  return ensureLiveSession(snapshot, options.workspacePath);
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && /^Session not found: /.test(error.message);
}

async function consumeEventStream(
  path: string,
  onEvent: (eventName: string, payload: any) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Accept: "text/event-stream",
    },
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of Readable.fromWeb(response.body as any)) {
      buffer += decoder.decode(chunk, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }

        const rawMessage = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseSseMessage(rawMessage);
        if (!parsed) {
          continue;
        }

        const shouldStop = await onEvent(parsed.event, parsed.data);
        if (shouldStop) {
          return;
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  }
}

function parseSseMessage(rawMessage: string): { event: string; data: any } | null {
  const lines = rawMessage.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: JSON.parse(dataLines.join("\n")),
  };
}

function printHelp(): void {
  const help = `
Usage:
  node ./bin/ag-bridge.js [--base-url URL] serve [--host 127.0.0.1] [--port 9464] [--data-dir PATH]
  node ./bin/ag-bridge.js [--base-url URL] status [--json]
  node ./bin/ag-bridge.js [--base-url URL] ag:list [--workspace PATH] [--json]
  node ./bin/ag-bridge.js [--base-url URL] ag:attach <cascadeId> [--workspace PATH]
  node ./bin/ag-bridge.js [--base-url URL] ag:sync [--workspace PATH] [--json]
  node ./bin/ag-bridge.js [--base-url URL] list-models [--workspace PATH] [--json]
  node ./bin/ag-bridge.js [--base-url URL] session:create [--mode connect|launch] [--workspace PATH] [--model MODEL] [--session-id ID]
  node ./bin/ag-bridge.js [--base-url URL] session:list [--json]
  node ./bin/ag-bridge.js [--base-url URL] session:get <sessionId>
  node ./bin/ag-bridge.js [--base-url URL] send <sessionId> <text> [--model MODEL] [--create-if-missing]
  node ./bin/ag-bridge.js [--base-url URL] events <sessionId> [--since N] [--limit N] [--json]
  node ./bin/ag-bridge.js [--base-url URL] stream <sessionId>
  node ./bin/ag-bridge.js [--base-url URL] cancel <sessionId>
  node ./bin/ag-bridge.js [--base-url URL] approve <sessionId> <stepIndex> [--scope once|conversation]
  node ./bin/ag-bridge.js [--base-url URL] export <sessionId>
  node ./bin/ag-bridge.js [--base-url URL] delete <sessionId>
  node ./bin/ag-bridge.js [--base-url URL] chat [--session ID|--last] [--session-id ID] [--workspace PATH] [--thinking on|off] [--model MODEL] [--create-if-missing]
  node ./bin/ag-bridge.js [--base-url URL] resume [sessionId] [--last] [--workspace PATH] [--thinking on|off] [--model MODEL] [--create-if-missing]
  node ./bin/ag-bridge.js [--base-url URL] ask <text> [--session ID|--last] [--session-id ID] [--workspace PATH] [--thinking on|off] [--model MODEL] [--create-if-missing]
`;
  process.stdout.write(help.trimStart());
}

function helpForChat(): string {
  return `
/help
/new [connect|launch] [workspacePath] [model] [sessionId]
/use <sessionId>
/resume [sessionId|last]
/sessions
/ag-sessions
/sync
/attach <cascadeId>
/status
/events [limit]
/export
/approve <stepIndex> [once|conversation]
/cancel
/thinking on|off
/quit
`.trimStart();
}

function printStatusSummary(status: ServerStatus): void {
  process.stdout.write(`Server: ${status.running ? "running" : "stopped"}\n`);
  process.stdout.write(`Address: ${status.address ?? "(not listening)"}\n`);
  process.stdout.write(`Requested port: ${status.requestedPort}\n`);
  process.stdout.write(`Actual port: ${status.actualPort ?? "(not listening)"}\n`);
  process.stdout.write(`Port switched: ${status.switchedPort ? "yes" : "no"}\n`);
  process.stdout.write(`Data dir: ${status.dataDir}\n`);
  process.stdout.write(`Sessions: total=${status.sessionCount} live=${status.liveSessionCount} persisted=${status.persistedSessionCount}\n`);
  process.stdout.write(`Clients: ${status.clientCount}\n`);
  if (status.startedAt) {
    process.stdout.write(`Started at: ${status.startedAt}\n`);
  }
  if (status.uptimeSeconds !== undefined) {
    process.stdout.write(`Uptime: ${status.uptimeSeconds}s\n`);
  }
}

function printSessionTable(sessions: SessionSnapshot[]): void {
  if (sessions.length === 0) {
    process.stdout.write("No sessions.\n");
    return;
  }

  process.stdout.write(
    `${pad("ID", 24)} ${pad("TITLE", 24)} ${pad("STATE", 6)} ${pad("MODE", 7)} ${pad("RUN", 10)} ${pad("MSG", 4)} ${pad("STEP", 5)} ${pad("UPDATED", 24)} PREVIEW\n`,
  );
  for (const session of sessions) {
    process.stdout.write(
      `${pad(session.id, 24)} ${pad(session.title ?? "-", 24)} ${pad(session.live ? "live" : "disk", 6)} ${pad(session.mode, 7)} ${pad(session.runStatus, 10)} ${pad(String(session.messageCount), 4)} ${pad(String(session.stepCount), 5)} ${pad(session.updatedAt, 24)} ${truncate(session.latestText || session.latestThinking, 80)}\n`,
    );
  }
}

function printAgSessionTable(sessions: AgSessionSummary[]): void {
  if (sessions.length === 0) {
    process.stdout.write("No AG sessions.\n");
    return;
  }

  process.stdout.write(
    `${pad("CASCADE", 28)} ${pad("TITLE", 24)} ${pad("STATE", 8)} ${pad("RUN", 10)} ${pad("STEP", 5)} ${pad("ATTACHED", 10)} SUMMARY\n`,
  );
  for (const session of sessions) {
    process.stdout.write(
      `${pad(session.cascadeId, 28)} ${pad(session.title ?? "-", 24)} ${pad(session.live ? "attached" : "remote", 8)} ${pad(session.runStatus, 10)} ${pad(String(session.stepCount), 5)} ${pad(session.attachedSessionId ?? "-", 10)} ${truncate(session.summary, 80)}\n`,
    );
  }
}

function printModelTable(models: AvailableModelSummary[]): void {
  if (models.length === 0) {
    process.stdout.write("No models.\n");
    return;
  }

  process.stdout.write(
    `${pad("LABEL", 30)} ${pad("KIND", 7)} ${pad("NAME", 36)} ${pad("ID", 4)} ${pad("RECOMM", 6)} ${pad("PREM", 4)} ${pad("STATE", 8)} KEY\n`,
  );
  for (const model of models) {
    process.stdout.write(
      `${pad(model.label, 30)} ${pad(model.kind, 7)} ${pad(model.name, 36)} ${pad(String(model.id), 4)} ${pad(model.isRecommended ? "yes" : "no", 6)} ${pad(model.isPremium ? "yes" : "no", 4)} ${pad(model.disabled ? "disabled" : "enabled", 8)} ${model.key}\n`,
    );
  }
}

function buildQuery(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function shortSessionId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

function formatEventPreview(event: BridgeEvent): string {
  const data = event.data as Record<string, unknown>;
  if (typeof data.description === "string") {
    return data.description;
  }
  if (typeof data.delta === "string") {
    return truncate(data.delta, 80);
  }
  if (typeof data.status === "string") {
    return String(data.status);
  }
  return JSON.stringify(data);
}

function truncate(value: string, width: number): string {
  if (!value) {
    return "";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= width) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, width - 3))}...`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value.slice(0, width);
  }
  return value.padEnd(width, " ");
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function stripFlag(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index === -1) {
    return [...args];
  }
  return args.filter((_, currentIndex) => currentIndex !== index && currentIndex !== index + 1);
}

function stripFlags(args: string[], ...flags: string[]): string[] {
  return flags.reduce((currentArgs, flag) => stripFlag(currentArgs, flag), [...args]);
}

function stripSwitch(args: string[], flag: string): string[] {
  return args.filter((value) => value !== flag);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireArg<T>(value: T, label: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && (error as any).name === "AbortError";
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

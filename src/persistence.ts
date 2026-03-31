import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { BridgeEvent, SessionExport, SessionSnapshot } from "./types.js";

const META_FILE = "meta.json";
const SNAPSHOT_FILE = "snapshot.json";
const EVENTS_FILE = "events.jsonl";

interface StoreMeta {
  version: number;
  createdAt: string;
}

export class BridgePersistenceStore {
  public readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly sessions = new Map<string, SessionSnapshot>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(this.dataDir, "sessions");
    this.init();
  }

  listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()].sort(compareByUpdatedAtDesc);
  }

  getSession(id: string): SessionSnapshot | undefined {
    return this.sessions.get(id);
  }

  syncSession(snapshot: SessionSnapshot, events: BridgeEvent[]): void {
    const persisted = toPersistedSnapshot(snapshot);
    const sessionDir = this.ensureSessionDir(snapshot.id);
    writeFileSync(path.join(sessionDir, SNAPSHOT_FILE), `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    writeFileSync(path.join(sessionDir, EVENTS_FILE), serializeEvents(events), "utf8");
    this.sessions.set(snapshot.id, persisted);
  }

  recordEvent(snapshot: SessionSnapshot, event: BridgeEvent): void {
    const persisted = toPersistedSnapshot(snapshot);
    const sessionDir = this.ensureSessionDir(snapshot.id);
    writeFileSync(path.join(sessionDir, SNAPSHOT_FILE), `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    appendFileSync(path.join(sessionDir, EVENTS_FILE), `${JSON.stringify(event)}\n`, "utf8");
    this.sessions.set(snapshot.id, persisted);
  }

  getEvents(id: string, since = 0, limit?: number): BridgeEvent[] {
    const sessionDir = path.join(this.sessionsDir, id);
    const eventsPath = path.join(sessionDir, EVENTS_FILE);
    if (!existsSync(eventsPath)) {
      return [];
    }

    const raw = readFileSync(eventsPath, "utf8");
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BridgeEvent)
      .filter((event) => event.seq > since);

    if (!limit || limit <= 0 || events.length <= limit) {
      return events;
    }

    return events.slice(events.length - limit);
  }

  exportSession(id: string): SessionExport | undefined {
    const session = this.getSession(id);
    if (!session) {
      return undefined;
    }

    return {
      session,
      events: this.getEvents(id),
    };
  }

  deleteSession(id: string): boolean {
    const sessionDir = path.join(this.sessionsDir, id);
    if (!existsSync(sessionDir)) {
      return false;
    }

    rmSync(sessionDir, { recursive: true, force: true });
    this.sessions.delete(id);
    return true;
  }

  private init(): void {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.sessionsDir, { recursive: true });

    const metaPath = path.join(this.dataDir, META_FILE);
    if (!existsSync(metaPath)) {
      const meta: StoreMeta = {
        version: 1,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    }

    for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const snapshotPath = path.join(this.sessionsDir, entry.name, SNAPSHOT_FILE);
      if (!existsSync(snapshotPath)) {
        continue;
      }

      try {
        const raw = readFileSync(snapshotPath, "utf8");
        const snapshot = JSON.parse(raw) as SessionSnapshot;
        this.sessions.set(snapshot.id, toPersistedSnapshot(snapshot));
      } catch {
        continue;
      }
    }
  }

  private ensureSessionDir(sessionId: string): string {
    const sessionDir = path.join(this.sessionsDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }
}

function toPersistedSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    live: false,
  };
}

function serializeEvents(events: BridgeEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function compareByUpdatedAtDesc(left: SessionSnapshot, right: SessionSnapshot): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

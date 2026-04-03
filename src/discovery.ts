import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

const DISCOVERY_PROTOCOL_VERSION = 1;
const REGISTRY_DIR = path.join(os.homedir(), ".ag-bridge", "registry");

export interface BridgeRegistryRecord {
  protocolVersion: number;
  instanceId: string;
  workspacePath: string;
  baseUrl: string;
  pid: number;
  startedAt: string;
}

export interface BridgeDiscoveryPublisher {
  readonly record: BridgeRegistryRecord;
  publish(): void;
  dispose(): void;
}

export function createBridgeDiscoveryPublisher(options: {
  workspacePath?: string;
  baseUrl: string;
  pid?: number;
  startedAt?: string;
  registryDir?: string;
  instanceId?: string;
}): BridgeDiscoveryPublisher | undefined {
  if (!options.workspacePath) {
    return undefined;
  }

  const workspacePath = canonicalizeWorkspacePath(options.workspacePath);
  const registryDir = options.registryDir ?? REGISTRY_DIR;
  const instanceId = options.instanceId ?? randomUUID();
  const record: BridgeRegistryRecord = {
    protocolVersion: DISCOVERY_PROTOCOL_VERSION,
    instanceId,
    workspacePath,
    baseUrl: options.baseUrl,
    pid: options.pid ?? process.pid,
    startedAt: options.startedAt ?? new Date().toISOString(),
  };
  const registryFilePath = path.join(registryDir, `${instanceId}.json`);

  return {
    record,
    publish(): void {
      fs.mkdirSync(registryDir, { recursive: true });
      const tempPath = `${registryFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, registryFilePath);
    },
    dispose(): void {
      try {
        fs.unlinkSync(registryFilePath);
      } catch {
        // Ignore stale or already-removed registry files.
      }
    },
  };
}

export function readBridgeRegistryRecords(registryDir = REGISTRY_DIR): BridgeRegistryRecord[] {
  if (!fs.existsSync(registryDir)) {
    return [];
  }

  return fs.readdirSync(registryDir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry) => {
      try {
        const raw = fs.readFileSync(path.join(registryDir, entry), "utf8");
        const parsed = JSON.parse(raw) as Partial<BridgeRegistryRecord>;
        if (
          parsed.protocolVersion !== DISCOVERY_PROTOCOL_VERSION
          || typeof parsed.instanceId !== "string"
          || typeof parsed.workspacePath !== "string"
          || typeof parsed.baseUrl !== "string"
          || typeof parsed.pid !== "number"
          || typeof parsed.startedAt !== "string"
        ) {
          return [];
        }

        return [{
          protocolVersion: parsed.protocolVersion,
          instanceId: parsed.instanceId,
          workspacePath: canonicalizeWorkspacePath(parsed.workspacePath),
          baseUrl: parsed.baseUrl,
          pid: parsed.pid,
          startedAt: parsed.startedAt,
        }];
      } catch {
        return [];
      }
    });
}

export function canonicalizeWorkspacePath(workspacePath: string): string {
  try {
    return fs.realpathSync.native(workspacePath);
  } catch {
    return path.resolve(workspacePath);
  }
}

export function getBridgeRegistryDir(): string {
  return REGISTRY_DIR;
}

import {
  Model,
  ModelAlias,
  ModelOrAlias,
} from "../vendor/antigravity-client/src/gen/exa/codeium_common_pb/codeium_common_pb.js";

export interface RequestedModelChoice {
  kind: "model" | "alias";
  value: Model | ModelAlias;
  name: string;
}

const FRIENDLY_MODEL_NAME_ALIASES: Record<string, string> = {
  flash: "google-gemini-2-5-flash",
  "flash-thinking": "google-gemini-2-5-flash-thinking",
  "flash-tools": "google-gemini-2-5-flash-thinking-tools",
  "flash-lite": "google-gemini-2-5-flash-lite",
  pro: "google-gemini-2-5-pro",
  "pro-low": "google-gemini-riftrunner-thinking-low",
  "pro-high": "google-gemini-riftrunner-thinking-high",
  sonnet: "claude-4-5-sonnet",
  "sonnet-thinking": "claude-4-5-sonnet-thinking",
  haiku: "claude-4-5-haiku",
  "haiku-thinking": "claude-4-5-haiku-thinking",
  opus: "claude-4-opus",
  "opus-thinking": "claude-4-opus-thinking",
  "gpt-oss": "openai-gpt-oss-120b-medium",
};

export function resolveRequestedModel(input?: string): RequestedModelChoice | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const { explicitKind, rawName } = splitExplicitKind(trimmed);
  if (/^\d+$/.test(rawName)) {
    return resolveRequestedModelById(rawName, explicitKind);
  }

  const normalizedName = normalizeModelName(resolveFriendlyModelAlias(rawName));
  const alias = resolveEnumName(ModelAlias, normalizedName);
  const model = resolveEnumName(Model, normalizedName);

  if (explicitKind === "alias") {
    if (!alias) {
      throw new Error(`Unknown model alias: ${input}`);
    }
    return alias;
  }

  if (explicitKind === "model") {
    if (!model) {
      throw new Error(`Unknown model: ${input}`);
    }
    return model;
  }

  if (alias) {
    return alias;
  }

  if (model) {
    return model;
  }

  throw new Error(
    `Unknown model: ${input}. Use names like CLAUDE_4_SONNET, GOOGLE_GEMINI_2_5_PRO, AUTO, RECOMMENDED, or short aliases like sonnet, pro, flash, and gpt-oss.`,
  );
}

export function toModelOrAlias(choice: RequestedModelChoice): ModelOrAlias {
  return new ModelOrAlias({
    choice:
      choice.kind === "alias"
        ? {
            case: "alias",
            value: choice.value as ModelAlias,
          }
        : {
            case: "model",
            value: choice.value as Model,
          },
  });
}

export function formatRequestedModel(choice?: RequestedModelChoice): string | undefined {
  if (!choice) {
    return undefined;
  }
  return `${choice.kind}:${choice.name}`;
}

export function getFriendlyModelAliases(kind: RequestedModelChoice["kind"], name: string): string[] {
  const normalizedName = normalizeModelName(name);
  return Object.entries(FRIENDLY_MODEL_NAME_ALIASES)
    .filter(([, target]) => {
      const normalizedTarget = normalizeModelName(target);
      if (normalizedTarget !== normalizedName) {
        return false;
      }
      return kind === "model";
    })
    .map(([alias]) => alias)
    .sort();
}

function splitExplicitKind(input: string): {
  explicitKind?: RequestedModelChoice["kind"];
  rawName: string;
} {
  if (input.startsWith("alias:")) {
    return {
      explicitKind: "alias",
      rawName: input.slice("alias:".length),
    };
  }

  if (input.startsWith("model:")) {
    return {
      explicitKind: "model",
      rawName: input.slice("model:".length),
    };
  }

  return {
    rawName: input,
  };
}

function resolveFriendlyModelAlias(input: string): string {
  const normalized = input.trim().toLowerCase();
  return FRIENDLY_MODEL_NAME_ALIASES[normalized] ?? input;
}

function resolveRequestedModelById(
  rawId: string,
  explicitKind?: RequestedModelChoice["kind"],
): RequestedModelChoice {
  const id = Number.parseInt(rawId, 10);
  const modelName = enumNameForId(Model, id);
  const aliasName = enumNameForId(ModelAlias, id);

  if (explicitKind === "model") {
    if (!modelName) {
      throw new Error(`Unknown model id: ${rawId}`);
    }
    return {
      kind: "model",
      value: id as Model,
      name: modelName,
    };
  }

  if (explicitKind === "alias") {
    if (!aliasName) {
      throw new Error(`Unknown model alias id: ${rawId}`);
    }
    return {
      kind: "alias",
      value: id as ModelAlias,
      name: aliasName,
    };
  }

  if (modelName && aliasName) {
    throw new Error(`Ambiguous model id: ${rawId}. Use model:${rawId} or alias:${rawId}.`);
  }

  if (modelName) {
    return {
      kind: "model",
      value: id as Model,
      name: modelName,
    };
  }

  if (aliasName) {
    return {
      kind: "alias",
      value: id as ModelAlias,
      name: aliasName,
    };
  }

  throw new Error(`Unknown model id: ${rawId}`);
}

function resolveEnumName(
  enumObject: typeof Model | typeof ModelAlias,
  normalizedName: string,
): RequestedModelChoice | undefined {
  for (const key of Object.keys(enumObject)) {
    if (!Number.isNaN(Number(key))) {
      continue;
    }

    const normalizedKey = normalizeModelName(key);
    if (normalizedKey !== normalizedName) {
      continue;
    }

    const value = enumObject[key as keyof typeof enumObject];
    if (typeof value !== "number") {
      continue;
    }

    if (enumObject === ModelAlias) {
      return {
        kind: "alias",
        value: value as ModelAlias,
        name: key,
      };
    }

    return {
      kind: "model",
      value: value as Model,
      name: key,
    };
  }

  return undefined;
}

function enumNameForId(enumObject: typeof Model | typeof ModelAlias, id: number): string | undefined {
  const value = (enumObject as unknown as Record<number, string | number>)[id];
  return typeof value === "string" ? value : undefined;
}

function normalizeModelName(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/^MODEL_ALIAS_/, "")
    .replace(/^MODEL_/, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

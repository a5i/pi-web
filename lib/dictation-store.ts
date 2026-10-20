import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import {
  DEFAULT_DICTATION_SETTINGS,
  isDictationBackend,
  isDictationLanguageCode,
  normalizeDictationSettings,
  type DictationSettings,
} from "./dictation-types";

// Voice dictation settings in `~/.pi/agent/dictation.json`, beside pi's own
// files: pi knows nothing about dictation, so unlike settings.json keys this
// file is entirely ours. Reads are tolerant (a hand-edited field falls back
// to its default); writes are minimal edits that keep unknown keys, are
// serialized in-process and replaced atomically.

const STORE_QUEUE: symbol = Symbol.for("pi-web:dictation-settings-write-queue");

export function getDictationSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "dictation.json");
}

function readStoredSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid dictation.json: expected an object");
  }
  return parsed as Record<string, unknown>;
}

/** The settings with defaults filled in; a missing file reads as defaults. */
export function readDictationSettings(settingsPath = getDictationSettingsPath()): DictationSettings {
  return normalizeDictationSettings(readStoredSettings(settingsPath));
}

function isModelIdOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 200);
}

/**
 * Minimal edit of the stored settings: only the keys `changes` names are
 * touched, unknown keys are kept for newer builds, and a value of the wrong
 * shape is refused rather than silently defaulted (the panel only sends what
 * it validated). Serialized per process and written atomically.
 */
export function writeDictationSettings(
  changes: Partial<Pick<DictationSettings, "model" | "language" | "threads" | "backend" | "historyEnabled">>,
  settingsPath = getDictationSettingsPath(),
): Promise<DictationSettings> {
  if ("model" in changes && !isModelIdOrNull(changes.model)) {
    throw new Error("Invalid dictation model: expected an id or null");
  }
  if ("language" in changes && !isDictationLanguageCode(changes.language)) {
    throw new Error("Invalid dictation language");
  }
  if ("threads" in changes) {
    const threads = changes.threads;
    if (typeof threads !== "number" || !Number.isInteger(threads) || threads < 0 || threads > 128) {
      throw new Error("Invalid dictation threads: expected an integer from 0 to 128");
    }
  }
  if ("backend" in changes && !isDictationBackend(changes.backend)) {
    throw new Error("Invalid dictation backend");
  }
  if ("historyEnabled" in changes && typeof changes.historyEnabled !== "boolean") {
    throw new Error("Invalid dictation historyEnabled: expected a boolean");
  }

  return serializeByKey(STORE_QUEUE, settingsPath, async () => {
    const stored = readStoredSettings(settingsPath);
    const next = { ...stored };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      next[key] = value;
    }
    next.version = 1;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
    return normalizeDictationSettings(next);
  });
}

/** Defaults, for callers that need the shape before any file exists. */
export { DEFAULT_DICTATION_SETTINGS };

import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Backend, TranscribeModel, TranscribeOptions } from "transcribe-cpp";
import { pcm16kDurationMs } from "./ffmpeg";
import { dictationModelFilePath } from "./dictation-models";

// The dictation engine: transcribe.cpp models loaded once per file+backend
// and kept warm for the process, because loading whisper weights takes
// seconds. Runs happen on koffi's worker threads (the event loop keeps
// serving), and the binding serializes computes per model itself. A model
// idles out after ten minutes to give the RAM back; the next request pays
// the load again.
//
// `transcribe-cpp` is imported dynamically: the package is a server external
// (next.config.ts) and must stay out of any module graph a test might load.

type SessionLike = {
  run: (pcm: Float32Array, opts?: TranscribeOptions) => Promise<{ text: string; language: string }>;
  dispose: () => void;
};

interface EngineEntry {
  model: TranscribeModel & { createSession: (opts?: { nThreads?: number }) => SessionLike };
  idleTimer: NodeJS.Timeout | null;
}

interface EngineStore {
  entries: Map<string, Promise<EngineEntry>>;
}

declare global {
  var __piWebDictationEngine: EngineStore | undefined;
}

const ENGINE: EngineStore = (globalThis.__piWebDictationEngine ??= { entries: new Map() });
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/** The transcribe request names a model that is not installed. */
export class DictationNoModelError extends Error {
  constructor(message = "No dictation model is installed") {
    super(message);
    this.name = "DictationNoModelError";
  }
}

function entryKey(modelPath: string, backend: string): string {
  return `${modelPath}::${backend}`;
}

function forgetEntry(key: string): void {
  const pending = ENGINE.entries.get(key);
  ENGINE.entries.delete(key);
  void pending?.then((entry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.model.dispose();
  }).catch(() => {});
}

/** Drops every loaded entry for a model file (a delete, or a re-download). */
export function unloadDictationModelFile(modelPath: string): void {
  for (const key of [...ENGINE.entries.keys()]) {
    if (key.startsWith(`${modelPath}::`)) forgetEntry(key);
  }
}

async function loadModel(modelPath: string, backend: string): Promise<EngineEntry> {
  const transcribe = await import("transcribe-cpp");
  const options: { backend?: Backend } = {};
  if (backend !== "auto") options.backend = backend as Backend;
  const model = await transcribe.TranscribeModel.load(modelPath, options);
  return { model: model as EngineEntry["model"], idleTimer: null };
}

function getEntry(modelPath: string, backend: string): Promise<EngineEntry> {
  const key = entryKey(modelPath, backend);
  const existing = ENGINE.entries.get(key);
  if (existing) return existing;
  // A different backend for the same file replaces the loaded one.
  for (const other of [...ENGINE.entries.keys()]) {
    if (other !== key && other.startsWith(`${modelPath}::`)) forgetEntry(other);
  }
  const pending = loadModel(modelPath, backend);
  ENGINE.entries.set(key, pending);
  pending.catch(() => {
    if (ENGINE.entries.get(key) === pending) ENGINE.entries.delete(key);
  });
  return pending;
}

function touchIdleTimer(entry: EngineEntry, key: string): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (ENGINE.entries.get(key)) forgetEntry(key);
  }, IDLE_UNLOAD_MS);
  entry.idleTimer.unref?.();
}

export interface DictationTranscribeOptions {
  modelId: string | null;
  /** "auto" or a language code; ignored when the model cannot take it. */
  language?: string;
  /** 0 keeps the library default. */
  threads?: number;
  backend?: string;
  signal?: AbortSignal;
  agentDir?: string;
}

export interface DictationTranscript {
  text: string;
  language: string;
  durationMs: number;
}

/**
 * One clip through the installed model. Throws `DictationNoModelError` when
 * the selected model file is gone, and whatever transcribe.cpp raises
 * otherwise (an `Aborted` when the signal fires).
 */
export async function transcribeWithDictation(
  pcm: Float32Array,
  options: DictationTranscribeOptions,
): Promise<DictationTranscript> {
  const modelPath = dictationModelFilePath(options.modelId, options.agentDir ?? getAgentDir());
  if (!modelPath || !existsSync(modelPath)) {
    throw new DictationNoModelError();
  }
  const backend = options.backend ?? "auto";
  const entry = await getEntry(modelPath, backend);
  touchIdleTimer(entry, entryKey(modelPath, backend));

  const session = entry.model.createSession(options?.threads ? { nThreads: options.threads } : undefined);
  try {
    const runOptions: TranscribeOptions = { timestamps: "none" };
    const language = options.language ?? "auto";
    if (language !== "auto") {
      // An English-only model cannot take another hint; let it detect.
      const languages = entry.model.capabilities?.languages ?? [];
      if (languages.length === 0 || languages.includes(language)) runOptions.language = language;
    }
    if (options.signal) runOptions.signal = options.signal;
    const result = await session.run(pcm, runOptions);
    return {
      text: result.text.trim(),
      language: result.language ?? "",
      durationMs: pcm16kDurationMs(pcm),
    };
  } finally {
    session.dispose();
  }
}

/** The backend kinds this process can offer, for the settings panel's select. */
export async function dictationBackendOptions(): Promise<string[]> {
  try {
    const transcribe = await import("transcribe-cpp");
    const devices = await transcribe.getAvailableBackendsAsync();
    const kinds = new Set<string>(["auto", "cpu"]);
    for (const device of devices) kinds.add(device.kind);
    // The settings' known backends only: an exotic kind the list cannot name
    // still works through "auto".
    const known = ["auto", "cpu", "cuda", "rocm", "vulkan", "metal"];
    return known.filter((backend) => kinds.has(backend));
  } catch {
    return ["auto", "cpu"];
  }
}

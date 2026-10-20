import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serializeByKey } from "./key-serializer";
import {
  CUSTOM_DICTATION_MODEL_EXTENSIONS,
  DICTATION_MODEL_CATALOG,
  findDictationCatalogEntry,
  findDictationCatalogEntryByFile,
} from "./dictation-catalog";
import type { DictationDownloadJob, DictationInstalledModel } from "./dictation-types";

// The dictation models directory (`~/.pi/agent/dictation-models`) and the
// downloads into it. Files never leave it: an id resolves to a catalog file
// name or to a `custom:<name>` file already listed there, and downloads fetch
// only the catalog's fixed URLs.

interface RunningDownloadJob extends DictationDownloadJob {
  controller: AbortController;
}

declare global {
  var __piWebDictationDownloadJobs: Map<string, RunningDownloadJob> | undefined;
}

const JOBS: Map<string, RunningDownloadJob> = (globalThis.__piWebDictationDownloadJobs ??= new Map());
const DOWNLOAD_QUEUE: symbol = Symbol.for("pi-web:dictation-model-download-queue");

export function getDictationModelsDir(agentDir = getAgentDir()): string {
  return join(agentDir, "dictation-models");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * What the directory holds: catalog files that exist (in catalog order),
 * then manually placed `.bin`/`.gguf`/`.ggml` files as custom models.
 * Partial downloads (`.part`) are invisible.
 */
export function listInstalledDictationModels(agentDir = getAgentDir()): DictationInstalledModel[] {
  const dir = getDictationModelsDir(agentDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const installed: DictationInstalledModel[] = [];
  for (const entry of DICTATION_MODEL_CATALOG) {
    if (present.has(entry.file)) {
      installed.push({ id: entry.id, file: entry.file, sizeBytes: fileSize(join(dir, entry.file)), custom: false });
    }
  }
  const custom = names
    .filter((name) => {
      if (name.endsWith(".part")) return false;
      if (findDictationCatalogEntryByFile(name)) return false;
      return CUSTOM_DICTATION_MODEL_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
    })
    .sort((a, b) => a.localeCompare(b));
  for (const name of custom) {
    installed.push({ id: `custom:${name}`, file: name, sizeBytes: fileSize(join(dir, name)), custom: true });
  }
  return installed;
}

/** The file an id names inside the models directory, or null for an id that cannot name one. */
export function dictationModelFilePath(id: string | null | undefined, agentDir = getAgentDir()): string | null {
  if (!id) return null;
  const entry = findDictationCatalogEntry(id);
  if (entry) return join(getDictationModelsDir(agentDir), entry.file);
  if (!id.startsWith("custom:")) return null;
  const name = id.slice("custom:".length);
  if (!/^[A-Za-z0-9._ -]+$/.test(name) || name.includes("..") || name.includes("/")) return null;
  if (!CUSTOM_DICTATION_MODEL_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) return null;
  return join(getDictationModelsDir(agentDir), name);
}

/** The jobs the settings panel polls: no controller, no AbortController leaks into JSON. */
export function getDictationDownloadJobs(): DictationDownloadJob[] {
  return [...JOBS.values()].map((job) => ({
    id: job.id,
    status: job.status,
    received: job.received,
    total: job.total,
    startedAt: job.startedAt,
    ...(job.error !== undefined ? { error: job.error } : {}),
  }));
}

export function isDictationModelDownloading(id: string): boolean {
  return JOBS.get(id)?.status === "downloading";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

/**
 * Downloads one catalog model into the directory, streamed to a `.part` file
 * that replaces the target atomically. The job's progress is visible through
 * `getDictationDownloadJobs()` while it runs; a network failure keeps the
 * job as an error entry (with the `.part` removed) until the next attempt.
 */
export async function startDictationModelDownload(id: string, agentDir = getAgentDir()): Promise<void> {
  const entry = findDictationCatalogEntry(id);
  if (!entry) throw new Error(`Unknown dictation model: ${id}`);

  await serializeByKey(DOWNLOAD_QUEUE, id, async () => {
    const dir = getDictationModelsDir(agentDir);
    const finalPath = join(dir, entry.file);
    if (existsSync(finalPath)) return;
    const running = JOBS.get(id);
    if (running?.status === "downloading") return;

    const job: RunningDownloadJob = {
      id,
      status: "downloading",
      received: 0,
      total: entry.sizeBytes,
      startedAt: Date.now(),
      controller: new AbortController(),
    };
    JOBS.set(id, job);
    const partPath = `${finalPath}.part`;

    try {
      mkdirSync(dir, { recursive: true });
      const response = await fetch(entry.url, { signal: job.controller.signal, redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 0) job.total = contentLength;

      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          job.received += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(response.body as unknown as NodeJS.ReadableStream, counter, createWriteStream(partPath, { mode: 0o600 }));
      renameSync(partPath, finalPath);
      JOBS.delete(id);
    } catch (error) {
      try {
        unlinkSync(partPath);
      } catch { /* nothing to clean up */ }
      if (isAbortError(error) || job.controller.signal.aborted) {
        JOBS.delete(id);
        return;
      }
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    }
  });
}

/** Aborts a running download; the queued task removes the job and its `.part` file. */
export function cancelDictationModelDownload(id: string): boolean {
  const job = JOBS.get(id);
  if (job?.status !== "downloading") return false;
  job.controller.abort();
  return true;
}

/**
 * Resolves once the download task has registered its job (or finished), so a
 * caller that only started the download still reports real state. Bounded:
 * never waits longer than the first network response should take.
 */
export async function waitForDictationDownloadStart(id: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!JOBS.has(id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The size of an error job's message, for display; cleared when a new attempt starts. */
export function dictationDownloadError(id: string): string | undefined {
  return JOBS.get(id)?.error;
}

/**
 * Deletes a downloaded or custom model file. Returns false when the id names
 * nothing installed; the caller decides what to do with a loaded engine
 * entry and the selected model before calling this.
 */
export function deleteDictationModelFile(id: string, agentDir = getAgentDir()): boolean {
  if (isDictationModelDownloading(id)) return false;
  const path = dictationModelFilePath(id, agentDir);
  if (!path || !existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

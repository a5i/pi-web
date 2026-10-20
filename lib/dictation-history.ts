import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import { DICTATION_HISTORY_LIMIT, type DictationHistoryEntry } from "./dictation-types";

// The dictation history: the last `DICTATION_HISTORY_LIMIT` recordings, audio
// exactly as the browser recorded it plus the transcript, under
// `~/.pi/agent/dictation-history/`. Every mutation is serialized in-process
// and the index is replaced atomically, so an append that evicts an old entry
// removes its audio in the same critical section. The directory sits beside
// pi's own files, outside the /api/files roots: audio leaves only through
// /api/dictation/history/[id]/audio, which serves ids the index knows.

const HISTORY_QUEUE: symbol = Symbol.for("pi-web:dictation-history-queue");
const ID_PATTERN = /^[a-z0-9-]{6,64}$/;

interface HistoryIndex {
  version: 1;
  /** Ascending by createdAt; the head is the oldest and the first evicted. */
  entries: DictationHistoryEntry[];
}

export function getDictationHistoryDir(agentDir = getAgentDir()): string {
  return join(agentDir, "dictation-history");
}

function historyIndexPath(dir: string): string {
  return join(dir, "index.json");
}

function readHistoryIndex(dir: string): HistoryIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyIndexPath(dir), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, entries: [] };
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return { version: 1, entries: [] };
    const valid = entries.filter((entry): entry is DictationHistoryEntry =>
      typeof entry === "object" && entry !== null
      && typeof (entry as DictationHistoryEntry).id === "string"
      && typeof (entry as DictationHistoryEntry).createdAt === "number");
    return { version: 1, entries: valid };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeHistoryIndex(dir: string, index: HistoryIndex): void {
  writePrivateFileAtomicSync(historyIndexPath(dir), JSON.stringify(index, null, 2));
}

/** Newest first, as the history panel lists them. */
export function listDictationHistory(agentDir = getAgentDir()): DictationHistoryEntry[] {
  return [...readHistoryIndex(getDictationHistoryDir(agentDir)).entries].reverse();
}

function extensionForMime(mime: string): string {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (normalized) {
    case "audio/webm": return ".webm";
    case "audio/mp4": return ".m4a";
    case "audio/mpeg": return ".mp3";
    case "audio/ogg": return ".oga";
    case "audio/wav": return ".wav";
    case "audio/aac": return ".aac";
    case "audio/x-matroska": return ".mkv";
    default: return ".bin";
  }
}

export interface DictationHistoryAppend {
  text: string;
  durationMs: number;
  model: string;
  audio: { data: Buffer; mime: string };
}

/** Adds one completed dictation, evicting the oldest past the limit. */
export async function appendDictationHistory(
  append: DictationHistoryAppend,
  agentDir = getAgentDir(),
): Promise<DictationHistoryEntry> {
  return serializeByKey(HISTORY_QUEUE, getDictationHistoryDir(agentDir), async () => {
    const dir = getDictationHistoryDir(agentDir);
    mkdirSync(dir, { recursive: true });
    const index = readHistoryIndex(dir);
    const id = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    const file = `${id}${extensionForMime(append.audio.mime)}`;
    writeFileSync(join(dir, file), append.audio.data, { mode: 0o600 });
    const entry: DictationHistoryEntry = {
      id,
      createdAt: Date.now(),
      durationMs: Math.round(append.durationMs),
      text: append.text,
      audioMime: append.audio.mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream",
      sizeBytes: append.audio.data.length,
      model: append.model,
    };
    index.entries.push(entry);
    while (index.entries.length > DICTATION_HISTORY_LIMIT) {
      const evicted = index.entries.shift();
      if (evicted) removeHistoryFile(dir, evicted.id);
    }
    writeHistoryIndex(dir, index);
    return entry;
  });
}

function removeHistoryFile(dir: string, id: string): void {
  if (!ID_PATTERN.test(id)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(id) && name.slice(id.length).indexOf(".") === 0) {
        unlinkSync(join(dir, name));
      }
    }
  } catch { /* nothing left to remove */ }
}

/** The audio file an id names, with its content type; only ids the index knows. */
export function getDictationHistoryAudio(
  id: string,
  agentDir = getAgentDir(),
): { path: string; mime: string; sizeBytes: number } | null {
  if (!ID_PATTERN.test(id)) return null;
  const dir = getDictationHistoryDir(agentDir);
  const entry = readHistoryIndex(dir).entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const extension = extensionForMime(entry.audioMime);
  const path = join(dir, `${entry.id}${extension}`);
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return null;
    return { path, mime: entry.audioMime, sizeBytes: stats.size };
  } catch {
    return null;
  }
}

/** Removes one entry with its audio; false when the id is unknown. */
export async function deleteDictationHistoryEntry(id: string, agentDir = getAgentDir()): Promise<boolean> {
  return serializeByKey(HISTORY_QUEUE, getDictationHistoryDir(agentDir), async () => {
    if (!ID_PATTERN.test(id)) return false;
    const dir = getDictationHistoryDir(agentDir);
    const index = readHistoryIndex(dir);
    const kept = index.entries.filter((entry) => entry.id !== id);
    if (kept.length === index.entries.length) return false;
    index.entries = kept;
    removeHistoryFile(dir, id);
    writeHistoryIndex(dir, index);
    return true;
  });
}

/** Removes every recording and the index. */
export async function clearDictationHistory(agentDir = getAgentDir()): Promise<void> {
  return serializeByKey(HISTORY_QUEUE, getDictationHistoryDir(agentDir), async () => {
    const dir = getDictationHistoryDir(agentDir);
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  });
}

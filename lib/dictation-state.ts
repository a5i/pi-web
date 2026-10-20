// Client-safe display and capture rules of the dictation composer UI. Pure
// functions only, so they test without a browser (see dictation-state.test.mjs).

import { DICTATION_MIN_RECORDING_MS } from "./dictation-types";

/** What the mic area shows; `error` rides beside any of them. */
export type DictationPhase = "idle" | "requesting" | "recording" | "processing";

export interface DictationError {
  kind: DictationErrorKind;
  /** The server's or browser's diagnostic, shown after the message. */
  message?: string;
}

export type DictationErrorKind =
  | "insecure"
  | "unsupported"
  | "permission"
  | "no-microphone"
  | "no-model"
  | "no-ffmpeg"
  | "audio-too-short"
  | "audio-too-long"
  | "too-large"
  | "server"
  | "network";

/** `m:ss`, the shape the recording timer shows. */
export function formatDictationTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The recorder mimeType a browser should use, or undefined when none of the
 * known formats is supported. Each browser records a format its own decoder
 * (here: the server's ffmpeg) handles; webm/opus first, then Safari's mp4.
 */
export function pickRecorderMimeType(isSupported: (mimeType: string) => boolean): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((mimeType) => isSupported(mimeType));
}

/** Maps a getUserMedia failure to the error the UI explains; "server" is a catch-all. */
export function dictationPermissionErrorKind(error: unknown): DictationErrorKind {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no-microphone";
  if (name === "TypeError") return "unsupported";
  return "server";
}

/** The error kind of a failed /api/dictation/transcribe response, by refusal reason. */
export function dictationErrorKindForReason(reason: string | undefined): DictationErrorKind {
  switch (reason) {
    case "no-model": return "no-model";
    case "no-ffmpeg": return "no-ffmpeg";
    case "audio-too-short": return "audio-too-short";
    case "audio-too-long":
    case "too-large": return "audio-too-long";
    default: return "server";
  }
}

/**
 * A recording shorter than this is an accidental click: the UI skips the
 * transcription request and returns to idle without touching the draft.
 */
export function isDictationRecordingTooShort(durationMs: number): boolean {
  return durationMs < DICTATION_MIN_RECORDING_MS;
}

/**
 * How a transcript joins text that is already in the composer when the
 * composer that started the dictation is gone by the time it arrives: the
 * same space-separation the in-place insertion applies at the cursor.
 */
export function appendDictationText(current: string, addition: string): string {
  const value = current.trimEnd();
  const text = addition.trim();
  if (!value) return text;
  if (!text) return value;
  return value.endsWith(" ") ? value + text : `${value} ${text}`;
}

/** `1.6 GB`, `488 MB`, `78 MB` — the sizes the settings rows show. */
export function formatDictationBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units: Array<[number, string]> = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "KB"],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${unit}`;
    }
  }
  return `${Math.round(bytes)} B`;
}

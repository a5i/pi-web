// Client-safe types and rules of voice dictation: the composer's mic button,
// Settings › Dictation and the /api/dictation routes all speak these shapes.
// Nothing here may import node builtins (it is bundled into the page).

/** Recordings kept on the server, audio included; the oldest is evicted first. */
export const DICTATION_HISTORY_LIMIT = 20;
/** The largest audio body /api/dictation/transcribe accepts. */
export const DICTATION_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
/** The client auto-stops a recording here; the server refuses longer audio. */
export const DICTATION_MAX_RECORDING_MS = 10 * 60 * 1000;
/** Shorter recordings are treated as accidental clicks, not dictation. */
export const DICTATION_MIN_RECORDING_MS = 400;

/** transcribe.cpp backend kinds a settings choice may name. */
export const DICTATION_BACKENDS = ["auto", "cpu", "cuda", "rocm", "vulkan", "metal"] as const;
export type DictationBackend = (typeof DICTATION_BACKENDS)[number];

/** The catalog entry Settings preselects until the user chooses otherwise. */
export const DICTATION_DEFAULT_MODEL = "whisper-large-v3-turbo";

export interface DictationSettings {
  /** A catalog id, a `custom:<file>` id, or null while nothing is selected. */
  model: string | null;
  /** "auto" (model detects) or a language code of `DICTATION_LANGUAGES`. */
  language: string;
  /** CPU threads for the run; 0 keeps the library default. */
  threads: number;
  backend: DictationBackend;
  historyEnabled: boolean;
}

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  model: DICTATION_DEFAULT_MODEL,
  language: "auto",
  threads: 0,
  backend: "auto",
  historyEnabled: true,
};

export interface DictationCatalogEntry {
  id: string;
  label: string;
  family: "whisper" | "parakeet";
  /** File name inside the dictation models directory. */
  file: string;
  /** Approximate download size, for display before the request starts. */
  sizeBytes: number;
  languages: "multilingual" | "en";
  recommended?: boolean;
  /** Short note shown under the label (English-only models &c). */
  notes?: string;
  /** Download source; the route only ever fetches catalog URLs, never input. */
  url: string;
}

export interface DictationInstalledModel {
  id: string;
  file: string;
  sizeBytes: number;
  /** True for a file the catalog does not know, placed there manually. */
  custom: boolean;
}

export interface DictationDownloadJob {
  id: string;
  status: "downloading" | "error";
  received: number;
  total: number;
  startedAt: number;
  error?: string;
}

export interface DictationHistoryEntry {
  id: string;
  createdAt: number;
  durationMs: number;
  text: string;
  audioMime: string;
  sizeBytes: number;
  /** The model id that produced the text. */
  model: string;
}

/** Languages offered beside Auto. Codes are the ones whisper models use. */
export const DICTATION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "cs", label: "Czech" },
  { code: "sk", label: "Slovak" },
  { code: "hu", label: "Hungarian" },
  { code: "ro", label: "Romanian" },
  { code: "bg", label: "Bulgarian" },
  { code: "el", label: "Greek" },
  { code: "sv", label: "Swedish" },
  { code: "da", label: "Danish" },
  { code: "nb", label: "Norwegian" },
  { code: "fi", label: "Finnish" },
  { code: "et", label: "Estonian" },
  { code: "lv", label: "Latvian" },
  { code: "lt", label: "Lithuanian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "he", label: "Hebrew" },
  { code: "fa", label: "Persian" },
  { code: "hi", label: "Hindi" },
  { code: "bn", label: "Bengali" },
  { code: "vi", label: "Vietnamese" },
  { code: "id", label: "Indonesian" },
  { code: "ms", label: "Malay" },
  { code: "th", label: "Thai" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "yue", label: "Cantonese" },
];

export function isDictationBackend(value: unknown): value is DictationBackend {
  return typeof value === "string" && (DICTATION_BACKENDS as readonly string[]).includes(value);
}

export function isDictationLanguageCode(value: unknown): value is string {
  return value === "auto"
    || (typeof value === "string" && DICTATION_LANGUAGES.some((language) => language.code === value));
}

/** A whole number of threads from 0 (library default) to 128; anything else reads as 0. */
export function clampDictationThreads(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  return Math.min(128, Math.max(0, value));
}

/**
 * One settings object as the store keeps it: every field falls back to its
 * default when it is absent or of the wrong shape, so a hand-edited or
 * older `dictation.json` never breaks the feature, and unknown keys are
 * preserved for newer builds.
 */
export function normalizeDictationSettings(stored: Record<string, unknown>): DictationSettings {
  return {
    model: typeof stored.model === "string" && stored.model.length > 0
      ? stored.model
      : stored.model === null
        ? null
        : DEFAULT_DICTATION_SETTINGS.model,
    language: isDictationLanguageCode(stored.language) ? stored.language : "auto",
    threads: clampDictationThreads(stored.threads),
    backend: isDictationBackend(stored.backend) ? stored.backend : "auto",
    historyEnabled: typeof stored.historyEnabled === "boolean" ? stored.historyEnabled : true,
  };
}

/** A model id a client may send: catalog spelling or `custom:<file>`; never a path. */
export function isDictationModelIdShape(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (value.startsWith("custom:")) {
    const name = value.slice("custom:".length);
    return /^[A-Za-z0-9._ -]+$/.test(name) && !name.includes("..") && !name.includes("/");
  }
  return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

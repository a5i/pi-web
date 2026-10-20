import type { DictationCatalogEntry } from "./dictation-types";

// The ASR models Settings › Dictation can download. The ids and URLs are
// fixed here: the download route accepts a catalog id, never a client URL,
// so a request cannot turn the server into an arbitrary downloader.

export const DICTATION_MODEL_CATALOG: readonly DictationCatalogEntry[] = [
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    family: "whisper",
    file: "ggml-large-v3-turbo.bin",
    sizeBytes: 1_642_000_000,
    languages: "multilingual",
    recommended: true,
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  },
  {
    id: "whisper-small",
    label: "Whisper Small",
    family: "whisper",
    file: "ggml-small.bin",
    sizeBytes: 488_000_000,
    languages: "multilingual",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
  {
    id: "whisper-base",
    label: "Whisper Base",
    family: "whisper",
    file: "ggml-base.bin",
    sizeBytes: 148_000_000,
    languages: "multilingual",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    family: "whisper",
    file: "ggml-tiny.bin",
    sizeBytes: 78_000_000,
    languages: "multilingual",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
  {
    id: "whisper-medium",
    label: "Whisper Medium",
    family: "whisper",
    file: "ggml-medium.bin",
    sizeBytes: 1_530_000_000,
    languages: "multilingual",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
  },
  {
    id: "parakeet-unified-en-0.6b-q8_0",
    label: "Parakeet Unified EN 0.6B (Q8_0)",
    family: "parakeet",
    file: "parakeet-unified-en-0.6b-Q8_0.gguf",
    sizeBytes: 731_000_000,
    languages: "en",
    notes: "English only; fast on CPU",
    url: "https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q8_0.gguf",
  },
];

/** Extensions a manually placed model file may carry to be picked up. */
export const CUSTOM_DICTATION_MODEL_EXTENSIONS = [".bin", ".gguf", ".ggml"] as const;

export function findDictationCatalogEntry(id: string | null | undefined): DictationCatalogEntry | undefined {
  if (!id) return undefined;
  return DICTATION_MODEL_CATALOG.find((entry) => entry.id === id);
}

export function findDictationCatalogEntryByFile(file: string): DictationCatalogEntry | undefined {
  return DICTATION_MODEL_CATALOG.find((entry) => entry.file === file);
}

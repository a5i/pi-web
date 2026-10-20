# Voice dictation (Settings › Dictation and the composer's mic)

One-directional dictation in the ChatGPT-Dictation sense: the mic button in
the composer records, the server transcribes, the text lands in the input as
editable text. It is not a voice mode: nothing is ever sent automatically,
and dictation works while a run streams (it never touches the agent's
streaming state).

## Server: ffmpeg + transcribe.cpp

- **ffmpeg is a hard requirement** (`lib/ffmpeg.ts`). The browser uploads the
  recording exactly as `MediaRecorder` produced it (webm/opus on Chromium and
  Firefox, mp4/AAC on Safari), and only ffmpeg turns it into the 16 kHz mono
  float32 PCM transcribe.cpp takes. There is no client-side decode and no
  server-side decoder dependency beyond ffmpeg itself. `findFfmpeg()` caches
  one `ffmpeg -version` probe per process (`PI_WEB_FFMPEG` overrides the
  command); Settings shows its verdict, and `/api/dictation/transcribe`
  refuses with `no-ffmpeg` (503) when it is missing.
- Transcription runs through the `transcribe-cpp` npm package (koffi N-API
  prebuilds, Node ≥ 22 — the repo already requires it). It is imported
  dynamically and both it and `koffi` are `serverExternalPackages`, so the
  native addon never enters a bundle graph and a machine without the package
  still loads every other module. Compute happens on koffi worker threads;
  the binding serializes computes per model itself.
- **Models** live in `~/.pi/agent/dictation-models/` (outside the /api/files
  roots). `lib/dictation-catalog.ts` is the fixed download list (whisper
  tiny→large-v3-turbo from ggerganov/whisper.cpp, parakeet-unified-en Q8_0);
  the route accepts a catalog **id**, never a URL, so a request cannot aim
  the server at an arbitrary host. Downloads stream to a `.part` file and
  rename atomically (`lib/dictation-models.ts`); progress is a globalThis
  job registry the settings panel polls through `GET /api/dictation`. Manual
  `.bin`/`.gguf`/`.ggml` files in the directory list as custom models
  (`custom:<file>` ids), Handy-style.
- **Settings** live in `~/.pi/agent/dictation.json` (`lib/dictation-store.ts`):
  pi knows nothing about dictation, so the file is entirely ours — unlike a
  settings.json key, nothing here can collide with a future pi setting.
  Reads fall back per-field; writes are minimal edits that keep unknown keys.
- **The engine** (`lib/dictation-engine.ts`) loads a model once per
  file+backend and keeps it warm (loading whisper weights takes seconds), then
  idles it out after ten minutes to give the RAM back. Deleting or
  re-downloading a file unloads it first. A `language` hint is passed only
  when the loaded model's `capabilities.languages` contains it — an
  English-only parakeet must not be told "ru".

## Routes (`app/api/dictation/**`)

- `GET/PUT /api/dictation` — status (settings, catalog, installed, jobs,
  ffmpeg, backends, history count) and settings saves. A `model` the
  directory does not hold is refused, so `settings.model` always names a real
  file or null.
- `POST /api/dictation/models` — `download`/`cancel`/`delete`. Deleting the
  selected model clears the selection.
- `POST /api/dictation/transcribe` — the raw recording as the body (audio/*
  or octet-stream, ≤ 64 MB → 413). ffmpeg decodes through pipes, then the
  model runs with `AbortSignal.timeout(60 s + 12× real time)`. Refusals carry
  a `reason` the client maps its error states on: `no-model`, `no-ffmpeg`,
  `audio-too-short` (< 400 ms, an accidental click), `audio-too-long`,
  `too-large`, `timeout`, `internal`. A successful run returns
  `{ text, language, durationMs, historyId? }`.
- `GET/POST /api/dictation/history`, `GET /api/dictation/history/[id]/audio`
  — the history index and its mutations; audio streams only for ids the
  index knows, from a path built from the id and the recorded mime.

## History (`lib/dictation-history.ts`)

The last 20 recordings with audio as recorded, under
`~/.pi/agent/dictation-history/` plus `index.json`. Every mutation is
serialized in-process (`serializeByKey`) and the index is replaced
atomically, so an append that evicts entry #1 removes its audio in the same
critical section. Appends happen only after a successful transcription, only
when `historyEnabled` is on; a failed append never fails the transcript. The
composer's clock button opens `components/DictationHistory.tsx`: player
(native `<audio>` against the streaming route), Insert (the same
cursor-space-join path as a transcript), Copy, Delete, Clear all.

## Client (`hooks/useDictation.ts`, `components/DictationPanel.tsx`)

- The hook owns the capture: `getUserMedia` in the click (the gesture iOS
  needs), `MediaRecorder` with the first supported mime of
  `pickRecorderMimeType()` (webm/opus → mp4), and an `AnalyserNode` feeding
  the waveform canvas — connected to the analyser only, never to
  `destination`, so there is no monitoring echo. The timer auto-stops at
  10 min; `DICTATION_MIN_RECORDING_MS` treats sub-400 ms stops as accidental
  clicks that post nothing.
- Phases: `idle → requesting → recording → processing → idle`, with an error
  riding beside them (`lib/dictation-state.ts` maps DOMException names and
  route `reason`s to kinds: `permission`, `insecure`, `no-model`, …). While
  recording, `DictationPanel` replaces the textarea in place — the draft,
  images and every other control stay; Esc cancels the recording with
  `preventDefault()` so `handleGlobalEscape` cannot also stop a running
  agent. Processing and errors are slim chips under the composer; the chip's
  ✕ marks the pending result discarded.
- **A transcript is inserted, never sent**: through
  `insertTextAtCursor` (the shared body of the handle's `insertText`), which
  uses `replaceTextareaRange` so native undo still covers it, with a
  space-join at the cursor. Repeat dictations append; sending stays the
  Send button's job. If the composer unmounts before the response arrives,
  the hook still holds the request and merges the text into that draftKey's
  draft store (`appendDictationText`), so switching sessions mid-transcription
  loses nothing.
- **Secure context is the main deployment trap**: `getUserMedia` does not
  exist on plain-http LAN origins, so the mic button hides itself there (and
  the insecure error text points at the access menu's https tunnels).
  Feature detection also hides it where `MediaRecorder` is missing; the
  compact quote composer never shows it.
- The mic's status poll (`GET /api/dictation`, every 30 s) knows whether a
  model is installed and ffmpeg runs; clicking the mic without either opens
  Settings › Dictation instead of recording (`onOpenDictationSettings`,
  threaded from ChatWindow's `onOpenSettings("dictation")`).

## Settings › Dictation (`components/DictationSettings.tsx`)

A plain section like General (no scope switch — everything is global):
ffmpeg status line, model rows (Use / Download with a live progress bar /
Delete, badges for recommended and language coverage, storage dir), language
select (`DICTATION_LANGUAGES`), backend select (from
`dictationBackendOptions()`, what this process can offer), threads (0 =
library default), and the history switch with Clear. Downloads are polled
every 1.5 s while one runs.

## Traps

- Client code must keep the iOS 16.2 rules: no RegExp lookbehind, no class
  static blocks (`lib/dictation-state.ts`, the panel, the hook).
- The recording panel owns focus while it runs; when it goes away the effect
  in ChatInput refocuses the textarea at the end so typing continues.
- `transcribe-cpp` is pinned exact like every other dependency; its platform
  package (`@transcribe-cpp/<tuple>`) arrives as an optional dependency and
  is resolved by its loader at runtime, which is why the externals matter.
- Windows prebuilds need the VC++ 2015–2022 x64 redistributable ≥ 14.40 —
  older runtimes crash with a native access violation during backend init
  (upstream README; the failure is a `BackendError`/load failure here).

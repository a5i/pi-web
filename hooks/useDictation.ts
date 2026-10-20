"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDraft, setDraft } from "@/lib/draft-store";
import { DICTATION_MAX_RECORDING_MS } from "@/lib/dictation-types";
import {
  appendDictationText,
  type DictationError,
  dictationErrorKindForReason,
  dictationPermissionErrorKind,
  isDictationRecordingTooShort,
  pickRecorderMimeType,
  type DictationPhase,
} from "@/lib/dictation-state";

// The composer's dictation recorder: getUserMedia + MediaRecorder capture,
// an AnalyserNode feeds the waveform, and the finished blob goes to
// /api/dictation/transcribe. Recording is local to the composer: nothing
// about it touches the agent's streaming state, and the request survives a
// composer remount (the transcript then lands in the draft store).

interface DictationStatus {
  loaded: boolean;
  modelInstalled: boolean;
  ffmpegAvailable: boolean;
}

/** One live level frame the waveform draws; written by rAF, read by the panel. */
export type DictationLevels = Uint8Array<ArrayBuffer> | null;

interface UseDictationOptions {
  draftKey?: string;
  /** False in the compact quote composer: no polling, no capture. */
  enabled?: boolean;
  /** Inserts the transcript into the composer (cursor position, space-joined). */
  onText: (text: string) => void;
}

const STATUS_REFETCH_MS = 30_000;

export function useDictation(options: UseDictationOptions) {
  const { draftKey, enabled = true, onText } = options;

  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [error, setError] = useState<DictationError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [status, setStatus] = useState<DictationStatus>({ loaded: false, modelInstalled: false, ffmpegAvailable: false });

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const mountedRef = useRef(true);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelsRef = useRef<DictationLevels>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelsFrameRef = useRef<number | null>(null);
  const cancelRequestedRef = useRef(false);
  const lastBlobRef = useRef<Blob | null>(null);
  const discardResultRef = useRef(false);

  const isCaptureSupported = enabled
    && typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";

  // The server side of the feature: a model must be selected and installed,
  // and ffmpeg must run. Polled lazily — the mic is a corner of the UI.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const response = await fetch("/api/dictation");
        if (!response.ok) return;
        const data = await response.json() as {
          settings?: { model?: string | null };
          installed?: { id: string }[];
          ffmpeg?: { available?: boolean };
        };
        if (cancelled) return;
        setStatus({
          loaded: true,
          modelInstalled: Boolean(
            data.settings?.model && (data.installed ?? []).some((entry) => entry.id === data.settings?.model),
          ),
          ffmpegAvailable: data.ffmpeg?.available === true,
        });
      } catch {
        if (!cancelled) setStatus((previous) => ({ ...previous, loaded: true }));
      } finally {
        if (!cancelled) timeout = setTimeout(read, STATUS_REFETCH_MS);
      }
    };
    void read();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [enabled]);

  const stopLevelsLoop = useCallback(() => {
    if (levelsFrameRef.current !== null) {
      cancelAnimationFrame(levelsFrameRef.current);
      levelsFrameRef.current = null;
    }
  }, []);

  const teardownCapture = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopLevelsLoop();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    analyserRef.current = null;
    levelsRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    void context?.close().catch(() => {});
  }, [stopLevelsLoop]);

  const deliverTranscript = useCallback((text: string) => {
    if (!text.trim()) return;
    if (mountedRef.current) {
      if (discardResultRef.current) return;
      onTextRef.current(text);
      return;
    }
    // The composer that started this dictation is gone: the transcript still
    // belongs to its draft.
    const key = draftKeyRef.current;
    if (!key) return;
    const draft = getDraft(key);
    setDraft(key, { value: appendDictationText(draft?.value ?? "", text), images: draft?.images ?? [] });
  }, []);

  const postTranscription = useCallback(async (blob: Blob) => {
    discardResultRef.current = false;
    try {
      const response = await fetch("/api/dictation/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { reason?: string; error?: string } | null;
        setError({
          kind: dictationErrorKindForReason(data?.reason),
          ...(data?.error ? { message: data.error } : {}),
        });
        if (mountedRef.current) setPhase("idle");
        return;
      }
      const data = await response.json() as { text?: string };
      setError(null);
      if (mountedRef.current) setPhase("idle");
      deliverTranscript(typeof data.text === "string" ? data.text : "");
    } catch {
      setError({ kind: "network" });
      if (mountedRef.current) setPhase("idle");
    }
  }, [deliverTranscript]);

  const handleRecorderStop = useCallback(() => {
    const chunks = chunksRef.current;
    const durationMs = performance.now() - startedAtRef.current;
    const mimeType = recorderRef.current?.mimeType || chunks[0]?.type || "audio/webm";
    teardownCapture();
    if (cancelRequestedRef.current) {
      cancelRequestedRef.current = false;
      if (mountedRef.current) {
        setPhase("idle");
        setElapsedMs(0);
      }
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    chunksRef.current = [];
    if (isDictationRecordingTooShort(durationMs)) {
      // An accidental click, not a dictation.
      if (mountedRef.current) {
        setPhase("idle");
        setElapsedMs(0);
      }
      return;
    }
    lastBlobRef.current = blob;
    if (mountedRef.current) setPhase("processing");
    void postTranscription(blob);
  }, [postTranscription, teardownCapture]);

  const startLevelsLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    levelsRef.current = new Uint8Array(analyser.fftSize);
    const sample = () => {
      const current = analyserRef.current;
      const levels = levelsRef.current;
      if (!current || !levels) return;
      current.getByteTimeDomainData(levels);
      levelsFrameRef.current = requestAnimationFrame(sample);
    };
    levelsFrameRef.current = requestAnimationFrame(sample);
  }, []);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setError(null);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError({ kind: "insecure" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError({ kind: "unsupported" });
      return;
    }

    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (cause) {
      setPhase("idle");
      setError({
        kind: dictationPermissionErrorKind(cause),
        ...(cause instanceof Error && cause.message ? { message: cause.message } : {}),
      });
      return;
    }

    try {
      streamRef.current = stream;
      const AudioContextClass = window.AudioContext;
      const context = new AudioContextClass();
      audioContextRef.current = context;
      // The click that started this is the user gesture iOS needs.
      await context.resume().catch(() => {});
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser); // Not to destination: no monitoring echo.
      analyserRef.current = analyser;

      const mimeType = pickRecorderMimeType((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelRequestedRef.current = false;
      lastBlobRef.current = null;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = handleRecorderStop;
      recorder.start(250);

      startedAtRef.current = performance.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        const elapsed = performance.now() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= DICTATION_MAX_RECORDING_MS && recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, 200);
      startLevelsLoop();
      setPhase("recording");
    } catch (cause) {
      teardownCapture();
      setPhase("idle");
      setError({
        kind: "server",
        ...(cause instanceof Error && cause.message ? { message: cause.message } : {}),
      });
    }
  }, [handleRecorderStop, startLevelsLoop, teardownCapture]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.stop(); // handleRecorderStop finishes: teardown, blob, request.
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    cancelRequestedRef.current = true;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    teardownCapture();
    setPhase("idle");
    setElapsedMs(0);
  }, [teardownCapture]);

  const retry = useCallback(() => {
    const blob = lastBlobRef.current;
    if (!blob || phaseRef.current === "processing") return;
    setError(null);
    setPhase("processing");
    void postTranscription(blob);
  }, [postTranscription]);

  /** The processing chip's ✕: the transcript is dropped when it arrives. */
  const discardResult = useCallback(() => {
    discardResultRef.current = true;
    setPhase("idle");
    setError(null);
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (phaseRef.current === "recording") {
        cancelRequestedRef.current = true;
        const recorder = recorderRef.current;
        if (recorder?.state === "recording") recorder.stop();
      }
      teardownCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    /** False when this browser cannot record at all: the mic button hides. */
    captureSupported: isCaptureSupported,
    phase,
    error,
    elapsedMs,
    levelsRef,
    status,
    start,
    stop,
    cancel,
    retry,
    discardResult,
    dismissError,
  };
}

import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";
import { DICTATION_MAX_AUDIO_BYTES, DICTATION_MAX_RECORDING_MS, DICTATION_MIN_RECORDING_MS } from "@/lib/dictation-types";
import { readDictationSettings } from "@/lib/dictation-store";
import { dictationModelFilePath } from "@/lib/dictation-models";
import { DictationNoModelError, transcribeWithDictation } from "@/lib/dictation-engine";
import { decodeAudioToPcm16kMono, findFfmpeg, pcm16kDurationMs } from "@/lib/ffmpeg";
import { appendDictationHistory } from "@/lib/dictation-history";
import { existsSync } from "node:fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The composer's stop button lands here: the raw MediaRecorder blob, decoded
// by ffmpeg to 16 kHz mono PCM, transcribed by the selected model, and kept
// in the history when it is on. The refusal `reason` is what the client maps
// its error states on.

/** Budget: a minute of setup plus twelve times real time for the run. */
function transcribeTimeoutMs(durationMs: number): number {
  return 60_000 + Math.round(durationMs) * 12;
}

function refusal(status: number, reason: string, error: string) {
  return NextResponse.json({ error, reason }, { status });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }

  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "" && contentType !== "application/octet-stream" && !contentType.startsWith("audio/")) {
    return refusal(415, "content-type", "Send the recording as audio/* or application/octet-stream");
  }

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > DICTATION_MAX_AUDIO_BYTES) {
    return refusal(413, "too-large", "Recording exceeds the size limit");
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await req.arrayBuffer());
  } catch (error) {
    return refusal(400, "invalid-audio", error instanceof Error ? error.message : "Failed to read the body");
  }
  if (buffer.length === 0) {
    return refusal(400, "invalid-audio", "Empty recording");
  }
  if (buffer.length > DICTATION_MAX_AUDIO_BYTES) {
    return refusal(413, "too-large", "Recording exceeds the size limit");
  }

  const agentDir = getAgentDir();
  const settings = readDictationSettings();

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg.available) {
    return refusal(503, "no-ffmpeg", "ffmpeg is not available on the server");
  }

  const modelPath = dictationModelFilePath(settings.model, agentDir);
  if (!modelPath || !existsSync(modelPath)) {
    return refusal(409, "no-model", "No dictation model is installed");
  }

  let pcm: Float32Array;
  try {
    pcm = await decodeAudioToPcm16kMono(buffer);
  } catch (error) {
    return refusal(400, "invalid-audio", error instanceof Error ? error.message : "ffmpeg failed to decode the recording");
  }

  const durationMs = pcm16kDurationMs(pcm);
  if (durationMs < DICTATION_MIN_RECORDING_MS) {
    return refusal(400, "audio-too-short", "Recording is too short");
  }
  if (durationMs > DICTATION_MAX_RECORDING_MS + 5_000) {
    return refusal(413, "audio-too-long", "Recording exceeds the length limit");
  }

  try {
    const transcript = await transcribeWithDictation(pcm, {
      modelId: settings.model,
      language: settings.language,
      threads: settings.threads,
      backend: settings.backend,
      signal: AbortSignal.timeout(transcribeTimeoutMs(durationMs)),
      agentDir,
    });

    let historyId: string | undefined;
    if (settings.historyEnabled) {
      try {
        const entry = await appendDictationHistory({
          text: transcript.text,
          durationMs: transcript.durationMs,
          model: settings.model ?? "",
          audio: { data: buffer, mime: contentType || "application/octet-stream" },
        }, agentDir);
        historyId = entry.id;
      } catch {
        // The transcript still reaches the composer when the history fails.
      }
    }

    return NextResponse.json({
      text: transcript.text,
      language: transcript.language,
      durationMs: Math.round(transcript.durationMs),
      ...(historyId !== undefined ? { historyId } : {}),
    });
  } catch (error) {
    if (error instanceof DictationNoModelError) {
      return refusal(409, "no-model", error.message);
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "Aborted" || name === "AbortError" || (error instanceof Error && /timeout/i.test(error.message))) {
      return refusal(504, "timeout", "Transcription timed out");
    }
    return refusal(500, "internal", error instanceof Error ? error.message : String(error));
  }
}

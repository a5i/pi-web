import { spawn } from "node:child_process";

// ffmpeg is a hard requirement of voice dictation: the browser uploads the
// audio exactly as MediaRecorder produced it (webm/opus, mp4/aac), and only
// ffmpeg turns it into the 16 kHz mono float32 PCM transcribe.cpp takes.
// Everything here spawns argv arrays without a shell.

interface FfmpegStatus {
  checkedAt: number;
  available: boolean;
  version: string | null;
}

declare global {
  var __piWebFfmpegStatus: FfmpegStatus | undefined;
}

/** The command to run: the `PI_WEB_FFMPEG` override, else `ffmpeg` from PATH. */
export function ffmpegCommand(): string {
  return process.env.PI_WEB_FFMPEG?.trim() || "ffmpeg";
}

function runFfmpegVersion(): Promise<FfmpegStatus> {
  return new Promise((resolve) => {
    const status: FfmpegStatus = { checkedAt: Date.now(), available: false, version: null };
    let child;
    try {
      child = spawn(ffmpegCommand(), ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(status);
      return;
    }
    let settled = false;
    const settle = (value: FfmpegStatus) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length > 4096 || status.version) return;
      stdout += chunk.toString("utf8");
      const match = stdout.match(/^ffmpeg version (\S+)/m);
      if (match) status.version = match[1];
    });
    child.on("error", () => settle(status));
    child.on("close", (code) => {
      status.available = code === 0 && status.version !== null;
      settle(status);
    });
  });
}

/** Whether ffmpeg runs, with its version; cached for the process lifetime. */
export async function findFfmpeg(): Promise<FfmpegStatus> {
  const cached = globalThis.__piWebFfmpegStatus;
  if (cached) return cached;
  const status = await runFfmpegVersion();
  globalThis.__piWebFfmpegStatus = status;
  return status;
}

const DECODE_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 400;

/**
 * Decodes any audio ffmpeg reads into mono float32 PCM at 16 kHz through
 * pipes: the input buffer never touches the disk. Rejects with the tail of
 * ffmpeg's stderr when the decode fails, and kills the process on timeout.
 */
export function decodeAudioToPcm16kMono(input: Buffer, timeoutMs = DECODE_TIMEOUT_MS): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegCommand(), [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-map", "a:0",
      "-f", "f32le",
      "-acodec", "pcm_f32le",
      "-ac", "1",
      "-ar", "16000",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const usable = total - (total % 4);
      if (usable === 0) {
        reject(new Error("ffmpeg produced no audio"));
        return;
      }
      const merged = Buffer.concat(chunks, usable);
      resolve(new Float32Array(merged.buffer, merged.byteOffset, usable / 4));
    };

    const timer = setTimeout(() => fail(new Error("ffmpeg timed out")), timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_TAIL_CHARS * 4) stderr += chunk.toString("utf8");
    });
    child.stderr?.on("error", () => {});
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) {
        done();
        return;
      }
      const tail = stderr.trim().slice(-STDERR_TAIL_CHARS);
      fail(new Error(tail || `ffmpeg exited with code ${code}`));
    });

    child.stdin?.on("error", () => { /* EPIPE when ffmpeg rejects the input early; the close handler reports it */ });
    child.stdin?.end(input);
  });
}

/** Duration of 16 kHz PCM in milliseconds. */
export function pcm16kDurationMs(pcm: Float32Array): number {
  return pcm.length / 16;
}

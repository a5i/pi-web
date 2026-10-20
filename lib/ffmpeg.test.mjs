import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { decodeAudioToPcm16kMono, findFfmpeg, pcm16kDurationMs } = await jiti.import("./ffmpeg.ts");

// ffmpeg is a hard requirement of dictation; these integration checks run
// only when it is installed (like lib/likec4-preview.test.mjs skips its
// heavy dependency). CI images without ffmpeg skip silently.
const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
const hasFfmpeg = probe.status === 0;

/** A minimal WAV writer: `seconds` of a 440 Hz sine, 16 kHz mono 16-bit. */
function sineWaveWav(seconds, sampleRate = 16_000) {
  const samples = Math.floor(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 12_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

test("findFfmpeg reports availability with a version", { skip: !hasFfmpeg }, async () => {
  const status = await findFfmpeg();
  assert.equal(status.available, true);
  assert.match(status.version ?? "", /\d/);
});

test("decodes a WAV to 16 kHz mono float32 PCM", { skip: !hasFfmpeg }, async () => {
  const pcm = await decodeAudioToPcm16kMono(sineWaveWav(1));
  assert.ok(Math.abs(pcm.length - 16_000) <= 4, `unexpected length ${pcm.length}`);
  assert.equal(pcm16kDurationMs(pcm), pcm.length / 16);
  // A sine's samples must not all be zero.
  let peak = 0;
  for (let index = 0; index < pcm.length; index += 16) peak = Math.max(peak, Math.abs(pcm[index]));
  assert.ok(peak > 0.1, `sine too quiet: ${peak}`);
});

test("resamples a 44.1 kHz WAV down to 16 kHz", { skip: !hasFfmpeg }, async () => {
  const pcm = await decodeAudioToPcm16kMono(sineWaveWav(1, 44_100));
  assert.ok(Math.abs(pcm.length - 16_000) <= 8, `unexpected length ${pcm.length}`);
});

test("garbage input is rejected with ffmpeg's message", { skip: !hasFfmpeg }, async () => {
  await assert.rejects(() => decodeAudioToPcm16kMono(Buffer.from("definitely not audio")));
});

test("a missing ffmpeg rejects the decode", async () => {
  const previous = process.env.PI_WEB_FFMPEG;
  globalThis.__piWebFfmpegStatus = undefined;
  process.env.PI_WEB_FFMPEG = "/nonexistent/ffmpeg";
  try {
    const status = await findFfmpeg();
    assert.equal(status.available, false);
    await assert.rejects(() => decodeAudioToPcm16kMono(sineWaveWav(0.1)));
  } finally {
    process.env.PI_WEB_FFMPEG = previous;
    globalThis.__piWebFfmpegStatus = undefined;
  }
});

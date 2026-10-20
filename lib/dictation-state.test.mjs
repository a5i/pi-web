import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendDictationText,
  dictationErrorKindForReason,
  dictationPermissionErrorKind,
  formatDictationBytes,
  formatDictationTimer,
  isDictationRecordingTooShort,
  pickRecorderMimeType,
} = await jiti.import("./dictation-state.ts");

test("formatDictationTimer renders m:ss", () => {
  assert.equal(formatDictationTimer(0), "0:00");
  assert.equal(formatDictationTimer(999), "0:00");
  assert.equal(formatDictationTimer(5_000), "0:05");
  assert.equal(formatDictationTimer(65_000), "1:05");
  assert.equal(formatDictationTimer(600_000), "10:00");
  assert.equal(formatDictationTimer(-50), "0:00");
});

test("pickRecorderMimeType prefers webm/opus, then mp4", () => {
  const everything = () => true;
  assert.equal(pickRecorderMimeType(everything), "audio/webm;codecs=opus");

  const safari = (mime) => mime === "audio/mp4";
  assert.equal(pickRecorderMimeType(safari), "audio/mp4");

  const nothing = () => false;
  assert.equal(pickRecorderMimeType(nothing), undefined);
});

test("permission errors map by DOMException name", () => {
  assert.equal(dictationPermissionErrorKind(new DOMException("denied", "NotAllowedError")), "permission");
  assert.equal(dictationPermissionErrorKind(new DOMException("insecure", "SecurityError")), "permission");
  assert.equal(dictationPermissionErrorKind(new DOMException("none", "NotFoundError")), "no-microphone");
  assert.equal(dictationPermissionErrorKind(new DOMException("constraint", "OverconstrainedError")), "no-microphone");
  assert.equal(dictationPermissionErrorKind(new TypeError("bad constraints")), "unsupported");
  assert.equal(dictationPermissionErrorKind(new Error("boom")), "server");
});

test("transcribe refusals map to their UI kinds", () => {
  assert.equal(dictationErrorKindForReason("no-model"), "no-model");
  assert.equal(dictationErrorKindForReason("no-ffmpeg"), "no-ffmpeg");
  assert.equal(dictationErrorKindForReason("audio-too-long"), "audio-too-long");
  assert.equal(dictationErrorKindForReason(undefined), "server");
});

test("recordings under the minimum are accidental clicks", () => {
  assert.equal(isDictationRecordingTooShort(0), true);
  assert.equal(isDictationRecordingTooShort(399), true);
  assert.equal(isDictationRecordingTooShort(400), false);
});

test("appendDictationText joins with a single space", () => {
  assert.equal(appendDictationText("", "hello"), "hello");
  assert.equal(appendDictationText("hello", "world"), "hello world");
  assert.equal(appendDictationText("hello ", "world"), "hello world");
  assert.equal(appendDictationText("hello", "  "), "hello");
  assert.equal(appendDictationText("hello  ", ""), "hello");
});

test("formatDictationBytes renders compact sizes", () => {
  assert.equal(formatDictationBytes(78_000_000), "74.4 MB");
  assert.match(formatDictationBytes(78_000_000), /^[\d.]+ MB$/);
  assert.match(formatDictationBytes(1_642_000_000), /^[\d.]+ GB$/);
  assert.equal(formatDictationBytes(0), "—");
});

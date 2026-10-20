import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clampDictationThreads,
  DEFAULT_DICTATION_SETTINGS,
  DICTATION_HISTORY_LIMIT,
  isDictationBackend,
  isDictationLanguageCode,
  isDictationModelIdShape,
  normalizeDictationSettings,
} = await jiti.import("./dictation-types.ts");

test("normalizeDictationSettings fills every field from an empty object", () => {
  assert.deepEqual(normalizeDictationSettings({}), DEFAULT_DICTATION_SETTINGS);
});

test("normalizeDictationSettings keeps valid values and drops invalid ones", () => {
  assert.deepEqual(normalizeDictationSettings({
    model: "whisper-small",
    language: "ru",
    threads: 8,
    backend: "cpu",
    historyEnabled: false,
    unknownFutureKey: { kept: true },
  }), {
    model: "whisper-small",
    language: "ru",
    threads: 8,
    backend: "cpu",
    historyEnabled: false,
  });

  assert.deepEqual(normalizeDictationSettings({
    model: 42,
    language: "klingon",
    threads: "many",
    backend: "quantum",
    historyEnabled: "yes",
  }), DEFAULT_DICTATION_SETTINGS);
});

test("an explicit null model survives normalization", () => {
  assert.equal(normalizeDictationSettings({ model: null }).model, null);
});

test("thread values clamp into 0..128 and reject non-integers", () => {
  assert.equal(clampDictationThreads(0), 0);
  assert.equal(clampDictationThreads(8), 8);
  assert.equal(clampDictationThreads(1000), 128);
  assert.equal(clampDictationThreads(-4), 0);
  assert.equal(clampDictationThreads(2.5), 0);
  assert.equal(clampDictationThreads("8"), 0);
});

test("language codes accept auto and the offered list only", () => {
  assert.equal(isDictationLanguageCode("auto"), true);
  assert.equal(isDictationLanguageCode("ru"), true);
  assert.equal(isDictationLanguageCode("en"), true);
  assert.equal(isDictationLanguageCode("klingon"), false);
  assert.equal(isDictationLanguageCode(7), false);
});

test("backends accept only the known kinds", () => {
  assert.equal(isDictationBackend("auto"), true);
  assert.equal(isDictationBackend("vulkan"), true);
  assert.equal(isDictationBackend("gpu"), false);
  assert.equal(isDictationBackend(null), false);
});

test("model ids are catalog spellings or custom:<file>, never paths", () => {
  assert.equal(isDictationModelIdShape("whisper-large-v3-turbo"), true);
  assert.equal(isDictationModelIdShape("custom:my-model.gguf"), true);
  assert.equal(isDictationModelIdShape("custom:../settings.json"), false);
  assert.equal(isDictationModelIdShape("custom:a/b.bin"), false);
  assert.equal(isDictationModelIdShape("/etc/passwd"), false);
  assert.equal(isDictationModelIdShape(""), false);
  assert.equal(isDictationModelIdShape(null), false);
});

test("the history limit is twenty recordings", () => {
  assert.equal(DICTATION_HISTORY_LIMIT, 20);
});

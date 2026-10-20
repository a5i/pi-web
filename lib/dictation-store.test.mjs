import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readDictationSettings, writeDictationSettings } = await jiti.import("./dictation-store.ts");

async function tempSettingsPath() {
  const dir = await mkdtempSync(join(tmpdir(), "pi-web-dictation-store-"));
  return { dir, path: join(dir, "dictation.json") };
}

test("a missing file reads as the defaults", async () => {
  const { path } = await tempSettingsPath();
  const settings = readDictationSettings(path);
  assert.equal(settings.model, "whisper-large-v3-turbo");
  assert.equal(settings.language, "auto");
  assert.equal(settings.threads, 0);
  assert.equal(settings.backend, "auto");
  assert.equal(settings.historyEnabled, true);
});

test("writes are minimal edits that keep unknown keys", async () => {
  const { path } = await tempSettingsPath();
  await writeDictationSettings({ language: "ru", threads: 8 }, path);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.language, "ru");
  assert.equal(raw.threads, 8);
  assert.equal(readDictationSettings(path).model, "whisper-large-v3-turbo");

  await writeFile(path, JSON.stringify({ ...raw, futureKey: [1, 2] }));
  const updated = await writeDictationSettings({ historyEnabled: false }, path);
  assert.equal(updated.historyEnabled, false);
  assert.equal(updated.language, "ru");
  const kept = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(kept.futureKey, [1, 2]);
});

test("a null model is stored, so nothing is selected", async () => {
  const { path } = await tempSettingsPath();
  assert.equal((await writeDictationSettings({ model: null }, path)).model, null);
});

test("invalid values are refused without writing", async () => {
  const { path } = await tempSettingsPath();
  assert.throws(() => writeDictationSettings({ language: "klingon" }, path));
  assert.throws(() => writeDictationSettings({ threads: -1 }, path));
  assert.throws(() => writeDictationSettings({ backend: "gpu" }, path));
  assert.throws(() => writeDictationSettings({ historyEnabled: "no" }, path));
  // The file was never created by the refused writes.
  const settings = readDictationSettings(path);
  assert.equal(settings.language, "auto");
});

test("a hand-edited file with invalid fields falls back per field", async () => {
  const { path } = await tempSettingsPath();
  await writeFile(path, JSON.stringify({ language: "ru", threads: 999, backend: "cpu" }));
  const settings = readDictationSettings(path);
  assert.equal(settings.language, "ru");
  assert.equal(settings.threads, 128);
  assert.equal(settings.backend, "cpu");
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deleteDictationModelFile,
  dictationModelFilePath,
  getDictationModelsDir,
  listInstalledDictationModels,
} = await jiti.import("./dictation-models.ts");

function tempAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-dictation-models-"));
}

test("an empty directory lists nothing", () => {
  const agentDir = tempAgentDir();
  assert.deepEqual(listInstalledDictationModels(agentDir), []);
});

test("catalog files are listed in catalog order, then customs alphabetically", () => {
  const agentDir = tempAgentDir();
  mkdirSync(getDictationModelsDir(agentDir), { recursive: true });
  const dir = getDictationModelsDir(agentDir);
  writeFileSync(join(dir, "ggml-tiny.bin"), "x");
  writeFileSync(join(dir, "zz-custom.gguf"), "yy");
  writeFileSync(join(dir, "aa-custom.bin"), "y");
  writeFileSync(join(dir, "ggml-large-v3-turbo.bin.part"), "partial");

  const installed = listInstalledDictationModels(agentDir);
  assert.deepEqual(installed.map((entry) => entry.id), [
    "whisper-tiny",
    "custom:aa-custom.bin",
    "custom:zz-custom.gguf",
  ]);
  assert.equal(installed.find((entry) => entry.id === "whisper-tiny")?.sizeBytes, 1);
  assert.equal(installed.find((entry) => entry.id === "custom:zz-custom.gguf")?.custom, true);
  // The .part download is invisible.
  assert.equal(installed.some((entry) => entry.file.endsWith(".part")), false);
});

test("ids resolve only to names inside the models directory", () => {
  const agentDir = tempAgentDir();
  assert.equal(
    dictationModelFilePath("whisper-tiny", agentDir),
    join(getDictationModelsDir(agentDir), "ggml-tiny.bin"),
  );
  assert.equal(
    dictationModelFilePath("custom:my model.gguf", agentDir),
    join(getDictationModelsDir(agentDir), "my model.gguf"),
  );
  assert.equal(dictationModelFilePath("custom:../settings.json", agentDir), null);
  assert.equal(dictationModelFilePath("custom:sub/dir.bin", agentDir), null);
  assert.equal(dictationModelFilePath("unknown-id", agentDir), null);
  assert.equal(dictationModelFilePath(null, agentDir), null);
});

test("delete removes an installed file and refuses unknown ids", () => {
  const agentDir = tempAgentDir();
  const dir = getDictationModelsDir(agentDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ggml-tiny.bin"), "x");
  assert.equal(deleteDictationModelFile("whisper-tiny", agentDir), true);
  assert.equal(deleteDictationModelFile("whisper-tiny", agentDir), false);
  assert.equal(deleteDictationModelFile("custom:nope.gguf", agentDir), false);
});

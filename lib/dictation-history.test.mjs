import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendDictationHistory,
  clearDictationHistory,
  deleteDictationHistoryEntry,
  getDictationHistoryAudio,
  getDictationHistoryDir,
  listDictationHistory,
} = await jiti.import("./dictation-history.ts");

function tempAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-dictation-history-"));
}

function append(agentDir, text, data = Buffer.from("audio-bytes")) {
  return appendDictationHistory({
    text,
    durationMs: 1500,
    model: "whisper-tiny",
    audio: { data, mime: "audio/webm" },
  }, agentDir);
}

test("entries list newest first with their audio on disk", async () => {
  const agentDir = tempAgentDir();
  await append(agentDir, "first");
  await append(agentDir, "second");

  const entries = listDictationHistory(agentDir);
  assert.deepEqual(entries.map((entry) => entry.text), ["second", "first"]);
  assert.equal(entries[0].audioMime, "audio/webm");
  assert.equal(entries[0].model, "whisper-tiny");

  const audio = getDictationHistoryAudio(entries[0].id, agentDir);
  assert.ok(audio);
  assert.ok(audio.path.endsWith(".webm"));
  assert.equal(audio.sizeBytes, 11);
});

test("the twenty-first recording evicts the oldest with its audio", async () => {
  const agentDir = tempAgentDir();
  for (let index = 0; index < 22; index++) {
    await append(agentDir, `note-${index}`);
  }
  const entries = listDictationHistory(agentDir);
  assert.equal(entries.length, 20);
  assert.equal(entries[entries.length - 1].text, "note-2");
  assert.equal(entries[0].text, "note-21");

  const files = readdirSync(getDictationHistoryDir(agentDir)).filter((name) => name !== "index.json");
  assert.equal(files.length, 20);
});

test("delete removes one entry and its audio; clear removes everything", async () => {
  const agentDir = tempAgentDir();
  await append(agentDir, "keep");
  const gone = await append(agentDir, "gone");

  assert.equal(await deleteDictationHistoryEntry(gone.id, agentDir), true);
  assert.equal(await deleteDictationHistoryEntry(gone.id, agentDir), false);
  assert.equal(listDictationHistory(agentDir).length, 1);
  assert.equal(getDictationHistoryAudio(gone.id, agentDir), null);

  await clearDictationHistory(agentDir);
  assert.deepEqual(listDictationHistory(agentDir), []);
  assert.equal(existsSync(getDictationHistoryDir(agentDir)), false);
});

test("ids the index never held are refused, whatever their shape", async () => {
  const agentDir = tempAgentDir();
  await append(agentDir, "one");
  assert.equal(await deleteDictationHistoryEntry("../settings.json", agentDir), false);
  assert.equal(getDictationHistoryAudio("no-such-entry", agentDir), null);
  assert.equal(getDictationHistoryAudio("", agentDir), null);
});

test("unknown audio content types still get a file and a safe mime", async () => {
  const agentDir = tempAgentDir();
  const entry = await appendDictationHistory({
    text: "odd",
    durationMs: 900,
    model: "whisper-tiny",
    audio: { data: Buffer.from([1, 2, 3]), mime: "audio/future-codec; boundary=x" },
  }, agentDir);
  assert.equal(entry.audioMime, "audio/future-codec");
  const audio = getDictationHistoryAudio(entry.id, agentDir);
  assert.ok(audio);
  assert.ok(audio.path.endsWith(".bin"));
});

test("a corrupted index reads as empty instead of throwing", async () => {
  const agentDir = tempAgentDir();
  const dir = getDictationHistoryDir(agentDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), "{not json");
  assert.deepEqual(listDictationHistory(agentDir), []);
});

import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { findDictationCatalogEntry } from "@/lib/dictation-catalog";
import { isDictationModelIdShape } from "@/lib/dictation-types";
import { readDictationSettings, writeDictationSettings } from "@/lib/dictation-store";
import {
  cancelDictationModelDownload,
  waitForDictationDownloadStart,
  deleteDictationModelFile,
  dictationModelFilePath,
  getDictationDownloadJobs,
  isDictationModelDownloading,
  listInstalledDictationModels,
  startDictationModelDownload,
} from "@/lib/dictation-models";
import { unloadDictationModelFile } from "@/lib/dictation-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Model management for Settings › Dictation: download a catalog entry (the
// job streams to disk and reports through GET /api/dictation), cancel it, or
// delete an installed file. Deleting the selected model clears the choice.

function state(agentDir = getAgentDir()) {
  return {
    settings: readDictationSettings(),
    installed: listInstalledDictationModels(agentDir),
    jobs: getDictationDownloadJobs(),
  };
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  const { action, id } = body as { action?: unknown; id?: unknown };
  if (action !== "download" && action !== "cancel" && action !== "delete") {
    return NextResponse.json({ error: "action must be download, cancel or delete" }, { status: 400 });
  }
  if (!isDictationModelIdShape(id)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  const modelId = id as string;
  const agentDir = getAgentDir();

  try {
    if (action === "download") {
      if (!findDictationCatalogEntry(modelId)) {
        return NextResponse.json({ error: "Unknown model" }, { status: 404 });
      }
      // The job streams in the background; the panel follows its progress
      // through the jobs in GET /api/dictation, so this must not hold the
      // request open for a gigabyte-scale download.
      void startDictationModelDownload(modelId, agentDir).catch(() => {
        // The job registry already carries the failure for the panel.
      });
      await waitForDictationDownloadStart(modelId);
      return NextResponse.json(state(agentDir));
    }

    if (action === "cancel") {
      cancelDictationModelDownload(modelId);
      return NextResponse.json(state(agentDir));
    }

    // delete
    if (isDictationModelDownloading(modelId)) {
      return NextResponse.json({ error: "Model is downloading" }, { status: 409 });
    }
    const path = dictationModelFilePath(modelId, agentDir);
    if (!path || !deleteDictationModelFile(modelId, agentDir)) {
      return NextResponse.json({ error: "Model is not installed" }, { status: 404 });
    }
    if (path) unloadDictationModelFile(path);
    let settings = readDictationSettings();
    if (settings.model === modelId) {
      settings = await writeDictationSettings({ model: null });
    }
    return NextResponse.json({ ...state(agentDir), settings });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

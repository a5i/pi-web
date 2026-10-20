import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { DICTATION_MODEL_CATALOG } from "@/lib/dictation-catalog";
import {
  isDictationBackend,
  isDictationLanguageCode,
  isDictationModelIdShape,
  type DictationCatalogEntry,
  type DictationDownloadJob,
  type DictationInstalledModel,
  type DictationSettings,
} from "@/lib/dictation-types";
import { readDictationSettings, writeDictationSettings } from "@/lib/dictation-store";
import { getDictationDownloadJobs, getDictationModelsDir, listInstalledDictationModels } from "@/lib/dictation-models";
import { dictationBackendOptions } from "@/lib/dictation-engine";
import { findFfmpeg } from "@/lib/ffmpeg";
import { listDictationHistory } from "@/lib/dictation-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Settings › Dictation and the composer's mic read this: what is configured,
// what is installed, what is downloading, and whether the hard requirement
// (ffmpeg) is met. The PUT saves settings the panel validated; a model the
// directory does not hold is refused so `settings.model` always names a real
// file or null.

interface DictationStatusResponse {
  settings: DictationSettings;
  catalog: readonly DictationCatalogEntry[];
  installed: DictationInstalledModel[];
  jobs: DictationDownloadJob[];
  storageDir: string;
  ffmpeg: { available: boolean; version: string | null };
  backends: string[];
  historyCount: number;
}

function statusResponse(agentDir = getAgentDir()): DictationStatusResponse {
  return {
    settings: readDictationSettings(),
    catalog: DICTATION_MODEL_CATALOG,
    installed: listInstalledDictationModels(agentDir),
    jobs: getDictationDownloadJobs(),
    storageDir: getDictationModelsDir(agentDir),
    ffmpeg: { available: false, version: null },
    backends: ["auto", "cpu"],
    historyCount: listDictationHistory(agentDir).length,
  };
}

export async function GET() {
  try {
    const status = statusResponse();
    const [ffmpeg, backends] = await Promise.all([findFfmpeg(), dictationBackendOptions()]);
    status.ffmpeg = { available: ffmpeg.available, version: ffmpeg.version };
    status.backends = backends;
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
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

  const changes = body as Record<string, unknown>;
  const keys = ["model", "language", "threads", "backend", "historyEnabled"];
  if (!keys.some((key) => key in changes)) {
    return NextResponse.json({ error: `Send one of ${keys.join(", ")}` }, { status: 400 });
  }

  const agentDir = getAgentDir();
  const installed = listInstalledDictationModels(agentDir);

  if ("model" in changes) {
    const model = changes.model;
    if (model === null) {
      // Nothing selected.
    } else if (!isDictationModelIdShape(model)) {
      return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
    } else if (!installed.some((entry) => entry.id === model)) {
      return NextResponse.json({ error: "Model is not installed" }, { status: 400 });
    }
  }
  if ("language" in changes && !isDictationLanguageCode(changes.language)) {
    return NextResponse.json({ error: "Invalid language" }, { status: 400 });
  }
  if ("backend" in changes && !isDictationBackend(changes.backend)) {
    return NextResponse.json({ error: "Invalid backend" }, { status: 400 });
  }

  try {
    const settings = await writeDictationSettings({
      ...( "model" in changes ? { model: changes.model as string | null } : {}),
      ...("language" in changes ? { language: changes.language as string } : {}),
      ...("threads" in changes ? { threads: changes.threads as number } : {}),
      ...("backend" in changes ? { backend: changes.backend as DictationSettings["backend"] } : {}),
      ...("historyEnabled" in changes ? { historyEnabled: changes.historyEnabled as boolean } : {}),
    });
    return NextResponse.json({ settings, installed, jobs: getDictationDownloadJobs() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

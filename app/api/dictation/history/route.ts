import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { clearDictationHistory, deleteDictationHistoryEntry, listDictationHistory } from "@/lib/dictation-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The history panel's list and its delete/clear actions. Audio streams from
// the [id]/audio route beside this one.

export async function GET() {
  try {
    return NextResponse.json({ entries: listDictationHistory(getAgentDir()) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
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
  if (action !== "delete" && action !== "clear") {
    return NextResponse.json({ error: "action must be delete or clear" }, { status: 400 });
  }
  if (action === "delete" && typeof id !== "string") {
    return NextResponse.json({ error: "id is required to delete one entry" }, { status: 400 });
  }

  try {
    const agentDir = getAgentDir();
    if (action === "clear") {
      await clearDictationHistory(agentDir);
    } else {
      const removed = await deleteDictationHistoryEntry(id as string, agentDir);
      if (!removed) {
        return NextResponse.json({ error: "Unknown history entry" }, { status: 404 });
      }
    }
    return NextResponse.json({ entries: listDictationHistory(agentDir) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

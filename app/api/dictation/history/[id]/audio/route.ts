import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getDictationHistoryAudio } from "@/lib/dictation-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One recording's audio, streamed for the history panel's player. Only ids
// the history index knows resolve; the path is built from the id and the
// mime the entry recorded, never from the request.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  const audio = getDictationHistoryAudio(id, getAgentDir());
  if (!audio) {
    return NextResponse.json({ error: "Unknown history entry" }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(audio.path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": audio.mime,
      "Content-Length": String(audio.sizeBytes),
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  LIKEC4_PREVIEW_MAX_BYTES,
  computeLikeC4Preview,
} from "@/lib/likec4-preview";

export const dynamic = "force-dynamic";

/**
 * Compute LikeC4 views for a .c4 source (a whole file, or a single ```likec4
 * fence). POST because the source travels in the body — a GET with the content
 * in the query string would break on size limits alone.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let body: { content?: unknown };
  try {
    body = await req.json() as { content?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) {
    return NextResponse.json({ ok: false, error: "content is required" }, { status: 400 });
  }
  if (Buffer.byteLength(content, "utf8") > LIKEC4_PREVIEW_MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: "LikeC4 source exceeds preview size limit" },
      { status: 413 },
    );
  }

  try {
    const result = await computeLikeC4Preview(content);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

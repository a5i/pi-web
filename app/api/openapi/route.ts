import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { bundleOpenApiSpec } from "@/lib/openapi-bundle";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

/**
 * Bundle a multi-file OpenAPI spec into one document so the preview can show
 * everything the root file references. POST { path } — the path must be a
 * real file inside the same allow-list /api/files serves from; every file the
 * spec references goes through that same check inside the bundler, and
 * network resolution is disabled there.
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

  let body: { path?: unknown };
  try {
    body = await req.json() as { path?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const path = typeof body.path === "string" ? body.path : "";
  if (!path.trim()) {
    return NextResponse.json({ ok: false, error: "path is required" }, { status: 400 });
  }

  // The same boundary /api/files enforces; symlink-resolved so a link cannot
  // smuggle a path outside the roots.
  if (!(await isExistingFilePathAllowed(path, await getAllowedFileRoots()))) {
    return NextResponse.json({ ok: false, error: "Path is not within the allowed file roots" }, { status: 403 });
  }

  try {
    const bundled = await bundleOpenApiSpec(path);
    return NextResponse.json({ ok: true, bundled });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: message },
      { status: message.includes("exceeds the bundle size limit") ? 413 : 500 },
    );
  }
}

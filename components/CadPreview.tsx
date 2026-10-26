"use client";

/**
 * STL preview pane for the file viewer.
 *
 * The raw file is fetched (`/api/files ?type=download`) and parsed in the
 * browser (lib/cad-stl.ts) — STL is its own triangle format, so unlike the
 * LikeC4/OpenAPI previews nothing here needs a server route. The heavy
 * renderer lives behind React.lazy in CadPreviewChunk; React.lazy caches a
 * rejection forever, which is the desired stance for a browser that cannot
 * parse the chunk — the boundary swaps in a message and the Source tab stays
 * one click away, exactly like a failed diagram render.
 */

import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { parseStl, STL_PREVIEW_MAX_BYTES, STL_PREVIEW_MAX_TRIANGLES, type StlMesh } from "@/lib/cad-stl";

const CadPreviewLazy = lazy(() =>
  import("./CadPreviewChunk").then((mod) => ({
    default: mod.CadPreviewPane,
  })),
);

interface ChunkBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class ChunkBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function fileApiUrl(
  filePath: string,
  type: "meta" | "download",
  sourceSessionId?: string | null,
): string {
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  return `/api/files/${encodeFilePathForApi(filePath)}?${searchParams.toString()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type CadState =
  | { status: "loading" }
  | { status: "error"; title: string; detail?: string }
  | { status: "ready"; mesh: StlMesh };

function useStlMesh(
  filePath: string,
  sourceSessionId: string | null | undefined,
  revision: number,
): CadState {
  const { t } = useI18n();
  const [state, setState] = useState<CadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    (async () => {
      try {
        // meta first: a clear size message beats streaming a 500 MB file into
        // the tab just to watch the parse fail.
        const metaResponse = await fetch(fileApiUrl(filePath, "meta", sourceSessionId), {
          signal: controller.signal,
        });
        const meta = (await metaResponse.json().catch(() => null)) as { size?: number; error?: string } | null;
        if (controller.signal.aborted) return;
        if (meta?.error) throw new Error(meta.error);
        if (typeof meta?.size === "number" && meta.size > STL_PREVIEW_MAX_BYTES) {
          setState({
            status: "error",
            title: t("i18n.stlTooLarge", { limit: formatBytes(meta.size) }),
          });
          return;
        }

        const response = await fetch(fileApiUrl(filePath, "download", sourceSessionId), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (controller.signal.aborted) return;

        setState({ status: "ready", mesh: parseStl(buffer) });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          title: t("i18n.stlParseFailed"),
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();

    return () => controller.abort();
  }, [filePath, sourceSessionId, revision, t]);

  return state;
}

interface CadPreviewProps {
  filePath: string;
  sourceSessionId?: string | null;
  /** Bumped by the viewer when a watch-triggered reload refetched the file. */
  revision?: number;
  onShowSource?: () => void;
}

export function CadPreview({ filePath, sourceSessionId, revision = 0, onShowSource }: CadPreviewProps) {
  const { t } = useI18n();
  const state = useStlMesh(filePath, sourceSessionId, revision);

  return (
    <div className="cad-preview">
      <div className="cad-preview-toolbar">
        {state.status === "ready" && (
          <>
            <span className="cad-preview-meta">
              {state.mesh.format} · {t("i18n.stlTriangleCount", { count: state.mesh.triangleCount.toLocaleString() })}
            </span>
            {state.mesh.truncated && (
              <span className="cad-preview-notice-chip">
                {t("i18n.stlTruncated", { count: STL_PREVIEW_MAX_TRIANGLES.toLocaleString() })}
              </span>
            )}
          </>
        )}
      </div>

      {state.status === "loading" && (
        <div className="likec4-canvas-state" aria-label={t("i18n.stlLoading")} />
      )}

      {state.status === "error" && (
        <div className="likec4-canvas-state is-error">
          <div>{state.title}</div>
          {state.detail && <div className="likec4-error-detail">{state.detail}</div>}
          {onShowSource && (
            <button type="button" className="likec4-source-link" onClick={onShowSource}>
              {t("i18n.source")}
            </button>
          )}
        </div>
      )}

      {state.status === "ready" && (
        <ChunkBoundary
          fallback={<div className="likec4-canvas-state is-error">{t("i18n.stlRendererFailed")}</div>}
        >
          <Suspense fallback={<div className="likec4-canvas-state" aria-label={t("i18n.stlLoading")} />}>
            <CadPreviewLazy mesh={state.mesh} />
          </Suspense>
        </ChunkBoundary>
      )}
    </div>
  );
}

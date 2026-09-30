"use client";

/**
 * OpenAPI (3.x) / Swagger (2.x) preview pane for the file viewer.
 *
 * Stoplight Elements renders everything client-side from the raw spec string.
 * Specs that reference other files ($ref: './common.yaml#/Pet') are bundled
 * server-side first (POST /api/openapi, which resolves refs relative to the
 * file's real location within the same allow-list /api/files enforces); when
 * that fails, the pane falls back to the raw root document and says so rather
 * than silently hiding the referenced parts.
 *
 * The heavy renderer lives behind React.lazy in OpenApiPreviewChunk: a
 * hand-rolled import() in an effect trips the React Compiler's rules-of-hooks
 * check under Next 16 dev. React.lazy caches a rejection forever, which is
 * the desired stance for a browser that cannot parse the chunk — the boundary
 * swaps in a message and the Source tab stays one click away, exactly like a
 * failed diagram render.
 */
import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { hasExternalRefs } from "@/lib/openapi";

const OpenApiPreviewLazy = lazy(() =>
  import("./OpenApiPreviewChunk").then((mod) => ({
    default: mod.OpenApiPreviewPane,
  })),
);

interface PreviewChunkBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class PreviewChunkBoundary extends Component<PreviewChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface ResolvedDocument {
  document: string;
  /** True when external refs exist but could not be bundled. */
  degraded: boolean;
}

function useResolvedDocument(source: string, filePath: string): ResolvedDocument {
  const needsBundle = useMemo(() => hasExternalRefs(source), [source]);
  const [resolved, setResolved] = useState<ResolvedDocument>({ document: source, degraded: false });

  useEffect(() => {
    // Single-file specs — the common case — never leave the browser: Elements
    // parses the raw string itself, like before the bundling route existed.
    if (!needsBundle) {
      setResolved({ document: source, degraded: false });
      return;
    }

    const controller = new AbortController();
    setResolved({ document: source, degraded: false });
    fetch("/api/openapi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
      signal: controller.signal,
    }).then(async (res) => {
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; bundled?: unknown }
        | null;
      if (controller.signal.aborted) return;
      if (res.ok && body?.ok && typeof body.bundled === "string" && body.bundled) {
        setResolved({ document: body.bundled, degraded: false });
      } else {
        setResolved({ document: source, degraded: true });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setResolved({ document: source, degraded: true });
    });

    return () => controller.abort();
  }, [source, filePath, needsBundle]);

  return resolved;
}

interface OpenApiPreviewProps {
  source: string;
  filePath: string;
}

export function OpenApiPreview({ source, filePath }: OpenApiPreviewProps) {
  const { t } = useI18n();
  const resolved = useResolvedDocument(source, filePath);

  return (
    <PreviewChunkBoundary
      fallback={<div className="likec4-canvas-state is-error">{t("i18n.openapiRendererFailed")}</div>}
    >
      <Suspense fallback={<div className="likec4-canvas-state" aria-label={t("i18n.openapiRendering")} />}>
        <OpenApiPreviewLazy
          document={resolved.document}
          notice={resolved.degraded ? t("i18n.openapiExternalRefsFailed") : undefined}
        />
      </Suspense>
    </PreviewChunkBoundary>
  );
}

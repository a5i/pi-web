"use client";

import { Component, Suspense, lazy, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { CodeBlock } from "./MermaidBlock";
import type { LikeC4Diagnostic } from "@/lib/likec4-preview";

/**
 * LikeC4 (.c4) preview.
 *
 * Parsing and Graphviz layout run on the server (POST /api/likec4); this
 * component only receives layouted views and lazily loads @likec4/diagram —
 * a ~1MB chunk with Mantine/xyflow that no other FileViewer path needs. The
 * chunk loads through React.lazy: a hand-rolled import().then(setState) in an
 * effect tripped the React Compiler's rules-of-hooks check under Next 16 dev.
 * When the chunk cannot load (old iOS Safari, offline chunk corruption) the
 * boundary swaps in a message and the source view stays one click away,
 * exactly like a failed Mermaid render.
 */

type DiagramComponent = ComponentType<{
  view: unknown;
  className?: string;
  pannable?: boolean;
  zoomable?: boolean;
  controls?: boolean;
  showNavigationButtons?: boolean;
  enableSearch?: boolean;
  background?: "transparent" | "solid" | "dots" | "lines" | "cross";
  onNavigateTo?: ((to: string) => void) | null;
}>;

// The chunk's export is generically typed against @likec4/core internals;
// views arrive as JSON, so the loose contract here is on purpose. React.lazy
// caches a rejection forever — a browser that cannot parse the chunk keeps
// showing the fallback until the page reloads, which is the desired stance.
const LikeC4DiagramLazy = lazy(() =>
  import("./LikeC4DiagramChunk").then((mod) => ({
    default: mod.LikeC4Diagram as DiagramComponent,
  })),
);

interface DiagramChunkBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class DiagramChunkBoundary extends Component<DiagramChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface LikeC4ClientView {
  id: string;
  title?: string | null;
}

interface ComputeState {
  status: "loading" | "error" | "ready";
  views: LikeC4ClientView[];
  diagnostics: LikeC4Diagnostic[];
  error: string | null;
}

function useLikeC4Computed(source: string): ComputeState {
  const [state, setState] = useState<ComputeState>({
    status: "loading",
    views: [],
    diagnostics: [],
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", views: [], diagnostics: [], error: null });

    fetch("/api/likec4", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: source }),
      signal: controller.signal,
    }).then(async (res) => {
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; views?: LikeC4ClientView[]; diagnostics?: LikeC4Diagnostic[]; error?: string }
        | null;
      if (controller.signal.aborted) return;
      if (!res.ok || !body?.ok) {
        setState({
          status: "error",
          views: [],
          diagnostics: [],
          error: body?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setState({
        status: "ready",
        views: Array.isArray(body.views) ? body.views : [],
        diagnostics: Array.isArray(body.diagnostics) ? body.diagnostics : [],
        error: null,
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        views: [],
        diagnostics: [],
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => controller.abort();
  }, [source]);

  return state;
}

interface ViewOption {
  id: string;
  label: string;
  folder: string | null;
}

/**
 * A `/` in a view title nests it into a folder; a backslash-escaped slash is
 * part of the name. Split manually — no regex lookbehind (Safari 16.2, #753).
 */
function splitViewTitle(title: string): { label: string; folder: string | null } {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < title.length; i++) {
    const ch = title.charAt(i);
    if (ch === "\\" && title.charAt(i + 1) === "/") {
      current += "/";
      i++;
      continue;
    }
    if (ch === "/") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  if (parts.length < 2) return { label: title, folder: null };
  return { label: parts[parts.length - 1], folder: parts.slice(0, -1).join("/") };
}

function toViewOptions(views: LikeC4ClientView[]): ViewOption[] {
  return views.map((view) => {
    const rawTitle = typeof view.title === "string" && view.title.trim() ? view.title : "";
    const title = rawTitle || String(view.id);
    const { label, folder } = splitViewTitle(title);
    return { id: String(view.id), label, folder };
  });
}

interface ViewSelection {
  view: LikeC4ClientView | null;
  setSelectedId: (id: string) => void;
}

function useSelectedView(views: LikeC4ClientView[]): ViewSelection {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep the current selection across watch-triggered recomputes when the
  // view still exists; otherwise fall back to the first view.
  const selected = useMemo(() => {
    if (selectedId !== null) {
      const found = views.find((view) => String(view.id) === selectedId);
      if (found) return found;
    }
    return views[0] ?? null;
  }, [selectedId, views]);

  return { view: selected, setSelectedId };
}

interface ViewSelectProps {
  options: ViewOption[];
  selectedId: string;
  onChange: (id: string) => void;
}

function ViewSelect({ options, selectedId, onChange }: ViewSelectProps) {
  const { t } = useI18n();

  const groups = useMemo(() => {
    const byFolder = new Map<string, ViewOption[]>();
    for (const option of options) {
      const key = option.folder ?? "";
      const list = byFolder.get(key);
      if (list) list.push(option);
      else byFolder.set(key, [option]);
    }
    return [...byFolder.entries()];
  }, [options]);

  if (options.length < 2) {
    const only = options[0];
    return <span className="likec4-view-title">{only ? `${only.folder ? `${only.folder} / ` : ""}${only.label}` : ""}</span>;
  }

  return (
    <select
      className="likec4-view-select"
      value={selectedId}
      aria-label={t("i18n.likec4View")}
      onChange={(event) => onChange(event.target.value)}
    >
      {groups.map(([folder, items]) =>
        folder ? (
          <optgroup key={folder} label={folder.split("/").join(" / ")}>
            {items.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </optgroup>
        ) : (
          items.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))
        ),
      )}
    </select>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: LikeC4Diagnostic[] }) {
  return (
    <ul className="likec4-diagnostics-list">
      {diagnostics.map((diagnostic, index) => (
        <li key={index} className={`likec4-diagnostic is-${diagnostic.severity}`}>
          {diagnostic.line > 0 && <span className="likec4-diagnostic-line">L{diagnostic.line + 1}</span>}
          <span className="likec4-diagnostic-message">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  );
}

interface DiagramCanvasProps {
  view: LikeC4ClientView;
  views: LikeC4ClientView[];
  onNavigate: (id: string) => void;
}

function DiagramCanvas({ view, views, onNavigate }: DiagramCanvasProps) {
  const { t } = useI18n();

  return (
    <DiagramChunkBoundary fallback={<div className="likec4-canvas-state is-error">{t("i18n.likec4RendererFailed")}</div>}>
      <Suspense fallback={<div className="likec4-canvas-state" aria-label={t("i18n.likec4Rendering")} />}>
        <LikeC4DiagramLazy
          view={view}
          pannable
          zoomable
          controls
          enableSearch={false}
          showNavigationButtons={false}
          onNavigateTo={(to) => {
            // Drill-down navigation stays inside the file: a target view the
            // server did not compute cannot be rendered here.
            const id = String(to);
            if (views.some((candidate) => String(candidate.id) === id)) onNavigate(id);
          }}
        />
      </Suspense>
    </DiagramChunkBoundary>
  );
}

interface LikeC4PreviewProps {
  source: string;
  onShowSource?: () => void;
}

export function LikeC4Preview({ source, onShowSource }: LikeC4PreviewProps) {
  const { t } = useI18n();
  const compute = useLikeC4Computed(source);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const { view: selectedView, setSelectedId } = useSelectedView(compute.views);
  const options = useMemo(() => toViewOptions(compute.views), [compute.views]);

  const errorCount = compute.diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = compute.diagnostics.length - errorCount;

  return (
    <div className="likec4-preview">
      <div className="likec4-preview-toolbar">
        {compute.status === "ready" && options.length > 0 && (
          <ViewSelect
            options={options}
            selectedId={String(selectedView?.id)}
            onChange={setSelectedId}
          />
        )}
        {compute.status === "ready" && options.length > 0 && (
          <span className="likec4-view-count">
            {t("i18n.likec4ViewsCount", { count: options.length })}
          </span>
        )}
        {compute.diagnostics.length > 0 && (
          <button
            type="button"
            className={["likec4-diagnostics-toggle", diagnosticsOpen ? "is-open" : ""].join(" ")}
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            {errorCount > 0 && <span className="likec4-diagnostic-badge is-error">{errorCount}</span>}
            {warningCount > 0 && <span className="likec4-diagnostic-badge is-warning">{warningCount}</span>}
            {t("i18n.likec4Diagnostics")}
          </button>
        )}
      </div>

      {diagnosticsOpen && compute.diagnostics.length > 0 && (
        <DiagnosticsList diagnostics={compute.diagnostics} />
      )}

      {compute.status === "loading" && (
        <div className="likec4-canvas-state" aria-label={t("i18n.likec4Rendering")} />
      )}

      {compute.status === "error" && (
        <div className="likec4-canvas-state is-error">
          <div>{t("i18n.likec4ComputeFailed")}</div>
          {compute.error && <div className="likec4-error-detail">{compute.error}</div>}
          {onShowSource && (
            <button type="button" className="likec4-source-link" onClick={onShowSource}>
              {t("i18n.source")}
            </button>
          )}
        </div>
      )}

      {compute.status === "ready" && !selectedView && (
        <div className="likec4-canvas-state is-empty">
          <div>{t("i18n.likec4NoViews")}</div>
          {onShowSource && (
            <button type="button" className="likec4-source-link" onClick={onShowSource}>
              {t("i18n.source")}
            </button>
          )}
        </div>
      )}

      {compute.status === "ready" && selectedView && (
        <div className="likec4-preview-canvas">
          <DiagramCanvas
            view={selectedView}
            views={compute.views}
            onNavigate={setSelectedId}
          />
        </div>
      )}
    </div>
  );
}

interface LikeC4FenceProps {
  code: string;
}

/** ```likec4 fenced block inside a markdown preview — the MermaidBlock pattern. */
export function LikeC4Fence({ code }: LikeC4FenceProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(true);
  const compute = useLikeC4Computed(code);
  const { view: selectedView, setSelectedId } = useSelectedView(compute.views);
  const options = useMemo(() => toViewOptions(compute.views), [compute.views]);

  if (!showPreview) {
    return (
      <CodeBlock
        code={code}
        lang="likec4"
        headerAction={(
          <button
            type="button"
            className="markdown-code-action"
            onClick={() => setShowPreview(true)}
            title={t("i18n.likec4PreviewDiagram")}
          >
            {t("i18n.preview")}
          </button>
        )}
      />
    );
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">likec4</span>
        <div className="markdown-code-actions">
          <button
            type="button"
            className="markdown-code-action"
            onClick={() => setShowPreview(false)}
            title={t("i18n.likec4ShowSource")}
          >
            {t("i18n.source")}
          </button>
        </div>
      </div>
      <div className="likec4-preview likec4-fence">
        {compute.status === "ready" && options.length > 1 && (
          <div className="likec4-preview-toolbar">
            <ViewSelect
              options={options}
              selectedId={String(selectedView?.id)}
              onChange={setSelectedId}
            />
          </div>
        )}
        {compute.status === "loading" && (
          <div className="likec4-canvas-state" aria-label={t("i18n.likec4Rendering")} />
        )}
        {compute.status === "error" && (
          <div className="likec4-canvas-state is-error">
            <div>{t("i18n.likec4ComputeFailed")}</div>
            {compute.error && <div className="likec4-error-detail">{compute.error}</div>}
          </div>
        )}
        {compute.status === "ready" && !selectedView && (
          <div className="likec4-canvas-state is-empty">{t("i18n.likec4NoViews")}</div>
        )}
        {compute.status === "ready" && selectedView && (
          <div className="likec4-preview-canvas">
            <DiagramCanvas
              view={selectedView}
              views={compute.views}
              onNavigate={setSelectedId}
            />
          </div>
        )}
      </div>
    </div>
  );
}

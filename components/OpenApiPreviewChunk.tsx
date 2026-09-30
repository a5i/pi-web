"use client";

/**
 * Lazy entry for the Stoplight Elements renderer (the <elements-api> web
 * component). This module exists so Elements' CSS ships inside the same async
 * chunk as its JS (the LikeC4DiagramChunk pattern): the scoped stylesheet is
 * ~300KB and a static import from OpenApiPreview would push it into every
 * FileViewer load.
 *
 * The stylesheet is the generated app-scoped copy (styles/elements-scoped.css
 * — regenerate with scripts/scope-elements-styles.mjs), NOT
 * @stoplight/elements/styles.min.css: the original's Tailwind preflight and
 * :root variable definitions would restyle the whole application the moment
 * this chunk loads.
 *
 * The web-components build is used instead of the React <API> component
 * because it bundles its own React: the renderer never touches pi-web's
 * exact-pinned React 19, which Elements does not test against
 * (stoplightio/elements#2793). It registers <elements-api> on
 * window.customElements at import time and must never load on the server —
 * this chunk is only reached through React.lazy inside a client-rendered page.
 */
import "@/styles/elements-scoped.css";
import "@stoplight/elements/web-components.min.js";

import { useLayoutEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

interface ElementsApiElement extends HTMLElement {
  apiDescriptionDocument?: string;
}

// The element's property surface is created in its constructor; the attribute
// spellings of the props set on <elements-api> below are declared here.
declare module "react" {
  /* eslint-disable-next-line @typescript-eslint/no-namespace -- module augmentation requires the namespace syntax */
  namespace JSX {
    interface IntrinsicElements {
      "elements-api": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          router?: string;
          layout?: string;
          "hide-try-it-panel"?: string;
        },
        HTMLElement
      >;
    }
  }
}

interface OpenApiPreviewPaneProps {
  /** Raw YAML/JSON source, or the server-bundled JSON string. */
  document: string;
  /** Muted notice shown above the docs (e.g. unresolvable external refs). */
  notice?: string;
}

export function OpenApiPreviewPane({ document: spec, notice }: OpenApiPreviewPaneProps) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const apiRef = useRef<HTMLElement | null>(null);

  // Bind the spec as a property before first paint. Property assignment (not
  // an attribute) keeps multi-hundred-KB specs out of the DOM attribute, and
  // the element's setter re-renders the docs when a watched file changes on
  // disk. router="memory" keeps navigation inside the pane instead of the
  // page URL, and hide-try-it-panel keeps a file preview read-only.
  useLayoutEffect(() => {
    const element = apiRef.current as ElementsApiElement | null;
    if (element) element.apiDescriptionDocument = spec;
  }, [spec]);

  // The scope class carries every Elements variable and preflight rule from
  // the scoped stylesheet; data-theme drives its light/dark variables.
  return (
    <div
      className="openapi-preview openapi-preview-scope"
      data-theme={isDark ? "dark" : "light"}
      role="region"
      aria-label={t("i18n.openapiPreview")}
    >
      {notice && <div className="openapi-preview-notice">{notice}</div>}
      <elements-api
        ref={apiRef}
        router="memory"
        layout="responsive"
        hide-try-it-panel="true"
      />
    </div>
  );
}

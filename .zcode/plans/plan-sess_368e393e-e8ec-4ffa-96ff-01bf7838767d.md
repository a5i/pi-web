# OpenAPI spec preview with Stoplight Elements

## Goal & approach

OpenAPI (3.x) and Swagger (2.x) files (`.yaml`/`.yml`/`.json`) open in FileViewer with a rendered **Preview** mode (Stoplight Elements API docs) next to the existing Source view, auto-selected on open like `.c4` files. It follows the established LikeC4 pattern: heavy renderer in a lazily imported chunk with its CSS imported *inside* that chunk, `React.lazy` + class error boundary + Suspense, zero global-style pollution, fully offline.

**No server route is needed**: unlike LikeC4, Elements parses the raw YAML/JSON string client-side (`apiDescriptionDocument` prop). Detection is also client-side — the language stays `yaml`/`json` and FileViewer sniffs the already-fetched content.

## Decisions (defaults taken; both trivially reversible)

- **Embedding: web component** (`@stoplight/elements/web-components.min.js`, `<elements-api>`). It bundles its own React 18, so pi-web's exact-pinned React 19.2.8 never interacts with Elements (which only tests React ≤18, issue stoplightio/elements#2793; its `ReactDOM.render` calls are internal to the bundled bridge). ~2 MB, lazy-loaded only when an OpenAPI file opens. The spec is passed via a JS property (`ref`), router `memory` (never touches the page URL, avoids the hash-router regression #2792), layout `sidebar`.
- **Docs-only**: `hideTryItPanel` (attribute/property verified against the installed package's `observedAttributes`) so a file preview never fires real HTTP requests. Flipping TryIt on later is a one-line change.

## Steps

1. **Dependency** — `npm install -D --save-exact @stoplight/elements@9.0.27` (devDependency + exact pin, matching the LikeC4 precedent). Add `"scarfSettings": { "enabled": false }` to package.json root (Elements' install-time analytics; offline/privacy). Peer dep is `react >=16.8`, so no ERESOLVE conflict with React 19.

2. **Detection helper** — new `lib/openapi.ts`: `isOpenApiSpecContent(content: string)` — true when the head of the document (first ~30 non-empty lines) has a top-level `openapi:`/`swagger:` (YAML) or `"openapi"`/`"swagger"` (JSON) key with a `2.x`/`3.x` version. Pure function, no server changes.

3. **Lazy preview chunk** — new `components/OpenApiPreviewChunk.tsx`, mirroring `LikeC4DiagramChunk.tsx`'s reason to exist: it imports `@stoplight/elements/styles.min.css` (297 KB, verified to contain zero remote `url()`/`@font-face` — offline-safe; "Inter" appears only as a font-family name with system fallbacks) and `@stoplight/elements/web-components.min.js`, and exports an `OpenApiPreview({ source, onShowSource })` pane component that renders `<elements-api>` with the doc property bound in an effect. Includes a local JSX intrinsic-element declaration (React 19 `React.JSX.IntrinsicElements`). Attribute names for `router`/`layout`/`hideTryItPanel` are verified against the installed package before wiring.

4. **FileViewer wiring** (`components/FileViewer.tsx`)
   - `const isOpenApi = (language === "yaml" || language === "json") && !data?.truncated && isOpenApiSpecContent(<fetched content>)` (same truncation gating as other previews; sniff the buffer the preview would receive).
   - Include `isOpenApi` in `hasPreview` (~L1363) and in the default-to-preview condition (~L1321); the Source/Preview mode switch picks up automatically from `hasPreview`.
   - Render branch next to the `isLikeC4` one (~L1800): `OpenApiPreviewLazy` (defined alongside `LikeC4DiagramLazy`) inside the same class error boundary + Suspense structure, with `onShowSource` → `updateDisplayMode("source")`. Invalid specs: Elements renders its own error UI; the boundary covers chunk-load failures.

5. **Styles & dark mode** (`app/globals.css`) — `.openapi-preview` pane styles next to the likec4 block; dark-theme overrides for the mosaic CSS variables scoped to the pane (exact variable names read from the installed `styles.min.css` at implementation). Check the stylesheet for unscoped element-level selectors (mosaic ships mostly `.sl-*` classes) and neutralize any that could leak into chat/markdown rendering.

6. **iOS 16.2 insurance** (`next.config.ts`) — add `@stoplight/elements`, `@stoplight/elements-core`, `@stoplight/mosaic`, `@stoplight/mosaic-code-viewer`, `@stoplight/mosaic-code-editor` to `transpilePackages` (published artifacts verified free of RegExp lookbehinds and class static blocks today; this guards future updates, mirroring the mermaid entry). Applies to both Turbopack and webpack; no new loader needed.

7. **Tests**
   - Unit `lib/openapi.test.mjs` (jiti-import pattern of `lib/likec4-preview.test.mjs`): YAML/JSON detection, OAS3/Swagger2, nested-key false-positive negatives, head-of-file limit.
   - E2E `e2e/openapi.mjs` following `e2e/likec4.mjs`: esbuild-bundle a host mounting `FileViewer`, mock `GET /api/files/...type=read` with a small real spec (`{ content, language: "yaml", truncated: false, ... }`), assert the docs render (info title + an operation summary), the Source/Preview toggle works, and zero console/page errors.

8. **Verify & document** — `node_modules/.bin/tsc --noEmit`, `npm run lint`, unit + new e2e, then a manual pass on the dev server (reuse an existing healthy server per AGENTS.md; never `next build`). Add a short LikeC4-style section to AGENTS.md: chunk pattern, offline constraints (no CDN refs in styles.min.css, scarf disabled), React-19 decoupling rationale, detection helper.

## Non-goals (noted for follow-up)

- Multi-file specs with **external `$ref`s**: the client-only parse cannot fetch sibling files (Elements needs an `apiDescriptionUrl` base for that). Internal refs work. A server-side bundling route (like `/api/likec4`, e.g. swagger-parser) can be added later if needed.
- ` ```openapi ` fences in markdown preview (LikeC4-fence equivalent).
- Elements theming beyond dark-mode variable overrides.
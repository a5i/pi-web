"use client";

/**
 * Lazy entry for the @likec4/diagram renderer.
 *
 * This module exists so the renderer's CSS (panda styled-system + xyflow base)
 * ships inside the same async chunk as its JS: a plain dynamic
 * `import("@likec4/diagram")` from LikeC4Preview would leave the styles behind,
 * and importing the CSS statically there would push ~200KB of unrelated CSS
 * into every FileViewer load.
 *
 * styles-font.css is deliberately NOT imported — it pulls IBM Plex Sans from a
 * CDN on jsdelivr, and pi-web must render fully offline.
 */
import "@likec4/diagram/styles-min.css";
import "@likec4/diagram/styles-xyflow.css";

export { LikeC4Diagram } from "@likec4/diagram";

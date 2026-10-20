"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatDictationTimer, type DictationError } from "@/lib/dictation-state";
import type { DictationLevels } from "@/hooks/useDictation";

// The composer's recording surface: it replaces the textarea while a
// dictation records, drawing the live waveform from the hook's level frames.
// Everything else in the app stays interactive; Escape cancels the recording
// (and is marked handled, so it cannot also stop a running agent).

const BAR_COUNT = 28;
const BAR_GAP = 2;
const BAR_MAX_HEIGHT = 22;
const BAR_MIN_HEIGHT = 3;

export function DictationPanel({
  elapsedMs,
  levelsRef,
  onStop,
  onCancel,
}: {
  elapsedMs: number;
  levelsRef: { current: DictationLevels };
  onStop: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const smoothRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame: number | null = null;

    const draw = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const scale = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(parent.clientWidth));
      const height = BAR_MAX_HEIGHT + 2;
      if (canvas.width !== width * scale || canvas.height !== height * scale) {
        canvas.width = width * scale;
        canvas.height = height * scale;
      }

      const styles = getComputedStyle(canvas);
      const accent = styles.getPropertyValue("--accent").trim() || "#3b82f6";
      const dim = styles.getPropertyValue("--text-dim").trim() || "#9ca3af";

      const levels = levelsRef.current;
      const smooth = smoothRef.current;
      while (smooth.length < BAR_COUNT) smooth.push(0);

      const usable = Math.max(width - (BAR_COUNT - 1) * BAR_GAP, 1);
      const barWidth = Math.max(2, Math.floor(usable / BAR_COUNT));
      const bucket = levels ? Math.floor(levels.length / BAR_COUNT) : 0;

      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      const centerY = height / 2;

      for (let bar = 0; bar < BAR_COUNT; bar++) {
        let level = 0;
        if (levels && bucket > 0) {
          let sum = 0;
          const start = bar * bucket;
          for (let index = start; index < start + bucket && index < levels.length; index++) {
            const deviation = (levels[index] - 128) / 128;
            sum += deviation * deviation;
          }
          level = Math.min(1, Math.sqrt(sum / bucket) * 2.6);
        }
        // Ease toward the new level so the wave breathes instead of flickering.
        smooth[bar] = smooth[bar] + (level - smooth[bar]) * (reduced ? 1 : 0.45);
        const barHeight = Math.max(BAR_MIN_HEIGHT, smooth[bar] * BAR_MAX_HEIGHT);
        const x = bar * (barWidth + BAR_GAP);
        context.fillStyle = smooth[bar] > 0.06 ? accent : dim;
        context.globalAlpha = smooth[bar] > 0.06 ? 0.95 : 0.4;
        const radius = Math.min(barWidth / 2, barHeight / 2, 1.5 + barHeight / 4);
        context.beginPath();
        // A rounded bar of at least the radius in both dimensions.
        const drawHeight = Math.max(barHeight, radius * 2);
        const drawWidth = Math.max(barWidth, radius * 2);
        if (typeof context.roundRect === "function") {
          context.roundRect(x, centerY - drawHeight / 2, drawWidth, drawHeight, radius);
        } else {
          context.rect(x, centerY - drawHeight / 2, drawWidth, drawHeight);
        }
        context.fill();
      }
      context.globalAlpha = 1;

      if (!reduced) frame = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [levelsRef]);

  return (
    <div
      role="group"
      aria-label={t("chat.dictationRecording")}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        minHeight: 38,
        outline: "none",
      }}
    >
      <button
        type="button"
        onClick={onCancel}
        title={t("chat.dictationCancel")}
        aria-label={t("chat.dictationCancel")}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.3)",
          borderRadius: 999,
          color: "#ef4444",
          cursor: "pointer",
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", overflow: "hidden" }}>
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ width: "100%", height: BAR_MAX_HEIGHT + 2, display: "block" }}
        />
      </div>

      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-muted)",
          fontVariantNumeric: "tabular-nums",
          minWidth: 38,
          textAlign: "right",
        }}
      >
        {formatDictationTimer(elapsedMs)}
      </span>

      <button
        type="button"
        onClick={onStop}
        title={t("chat.dictationStop")}
        aria-label={t("chat.dictationStop")}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: "var(--accent)",
          border: "none",
          borderRadius: 999,
          color: "var(--accent-contrast, #fff)",
          cursor: "pointer",
          boxShadow: "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)",
          transition: "filter 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.08)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="4 12.5 9.5 18 20 6.5" />
        </svg>
      </button>
    </div>
  );
}

/** The slim row under the composer while a recording is being transcribed. */
export function DictationProcessingChip({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 6,
        padding: "4px 10px",
        border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        borderRadius: 8,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontSize: 12,
      }}
    >
      <svg className="animate-spin motion-reduce:animate-none" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span style={{ flex: 1, minWidth: 0 }}>{t("chat.dictationProcessing")}</span>
      <button
        type="button"
        onClick={onDismiss}
        title={t("chat.dictationDismiss")}
        aria-label={t("chat.dictationDismiss")}
        style={{ flexShrink: 0, background: "none", border: "none", padding: "0 2px", color: "inherit", opacity: 0.7, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

/** What went wrong, with the actions the error still allows. */
export function DictationErrorChip({
  error,
  onRetry,
  onRecordAgain,
  onDismiss,
  onOpenSettings,
}: {
  error: DictationError;
  onRetry: () => void;
  onRecordAgain: () => void;
  onDismiss: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useI18n();
  const messageKey = `chat.dictationError.${error.kind}` as const;
  const fallback = error.message ?? "";
  const retryable = error.kind === "server" || error.kind === "network";

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        marginTop: 6,
        padding: "5px 10px",
        border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: 8,
        background: "rgba(239,68,68,0.07)",
        color: "rgb(239,68,68)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true">
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <span>{t(messageKey)}</span>
        {fallback && <span style={{ opacity: 0.75, overflowWrap: "anywhere" }}> · {fallback}</span>}
        {(error.kind === "no-model" || error.kind === "no-ffmpeg") && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            style={{
              marginLeft: 8,
              background: "none",
              border: "none",
              padding: 0,
              color: "inherit",
              textDecoration: "underline",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t("chat.dictationOpenSettings")}
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {retryable && (
          <button
            type="button"
            onClick={onRetry}
            style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 12 }}
          >
            {t("chat.dictationRetry")}
          </button>
        )}
        {error.kind !== "permission" && error.kind !== "insecure" && error.kind !== "unsupported" && (
          <button
            type="button"
            onClick={onRecordAgain}
            style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 12 }}
          >
            {t("chat.dictationRecordAgain")}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          title={t("chat.dictationDismiss")}
          aria-label={t("chat.dictationDismiss")}
          style={{ background: "none", border: "none", padding: "0 2px", color: "inherit", opacity: 0.7, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

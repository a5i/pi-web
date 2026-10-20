"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatDictationTimer } from "@/lib/dictation-state";
import type { DictationHistoryEntry } from "@/lib/dictation-types";

// The dictation history dropdown above the composer: the last recordings
// with a player, and actions that hand the text back to the composer. It is
// a popover of the chat area, not a settings page.

function formatEntryTime(createdAt: number): string {
  const date = new Date(createdAt);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return time;
  return `${date.toLocaleDateString()} ${time}`;
}

export function DictationHistory({
  onClose,
  onInsert,
}: {
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<DictationHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/dictation/history")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ entries?: DictationHistoryEntry[] }>;
      })
      .then((data) => {
        if (!cancelled) setEntries(data.entries ?? []);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  const mutate = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/dictation/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { entries?: DictationHistoryEntry[]; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setEntries(data.entries ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyEntry = async (entry: DictationHistoryEntry) => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((current) => (current === entry.id ? null : current)), 1500);
    } catch {
      setError(t("chat.dictationHistoryCopyFailed"));
    }
  };

  const actionLink = {
    background: "none",
    border: "none",
    padding: 0,
    color: "var(--accent)",
    textDecoration: "underline",
    cursor: "pointer",
    fontSize: 11.5,
  } as const;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("chat.dictationHistory")}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        zIndex: 100,
        width: "min(380px, calc(100vw - 32px))",
        maxHeight: 340,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 -4px 24px rgba(0,0,0,0.14)",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          {t("chat.dictationHistory")}
        </span>
        {entries && entries.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void mutate({ action: "clear" })}
            style={{ ...actionLink, color: "var(--text-dim)" }}
          >
            {t("chat.dictationHistoryClear")}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t("i18n.close")}
          aria-label={t("i18n.close")}
          style={{ flexShrink: 0, background: "none", border: "none", padding: "0 2px", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      {error && (
        <div style={{ padding: "6px 10px", fontSize: 11.5, color: "#ef4444", borderBottom: "1px solid var(--border)" }}>{error}</div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 4 }}>
        {entries === null && (
          <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.dictationHistoryLoading")}</div>
        )}
        {entries !== null && entries.length === 0 && (
          <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.dictationHistoryEmpty")}</div>
        )}
        {entries?.map((entry) => (
          <div
            key={entry.id}
            style={{
              padding: "7px 8px",
              borderRadius: 7,
              display: "flex",
              flexDirection: "column",
              gap: 5,
              background: playingId === entry.id ? "var(--bg-hover)" : "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = playingId === entry.id ? "var(--bg-hover)" : "none"; }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}>
                {formatEntryTime(entry.createdAt)} · {formatDictationTimer(entry.durationMs)}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                {entry.text}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                type="button"
                style={actionLink}
                onClick={() => setPlayingId((current) => (current === entry.id ? null : entry.id))}
              >
                {playingId === entry.id ? t("chat.dictationHistoryHide") : t("chat.dictationHistoryPlay")}
              </button>
              <button type="button" style={actionLink} disabled={!entry.text.trim()} onClick={() => { onInsert(entry.text); onClose(); }}>
                {t("chat.dictationHistoryInsert")}
              </button>
              <button type="button" style={actionLink} onClick={() => void copyEntry(entry)}>
                {copiedId === entry.id ? t("chat.dictationHistoryCopied") : t("chat.dictationHistoryCopy")}
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" style={{ ...actionLink, color: "var(--text-dim)" }} disabled={busy} onClick={() => void mutate({ action: "delete", id: entry.id })}>
                {t("chat.dictationHistoryDelete")}
              </button>
            </div>
            {playingId === entry.id && (
              <audio controls preload="none" src={`/api/dictation/history/${encodeURIComponent(entry.id)}/audio`} style={{ width: "100%", height: 32 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

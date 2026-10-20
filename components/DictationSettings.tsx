"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSwitch } from "./SettingsUi";
import { formatDictationBytes } from "@/lib/dictation-state";
import {
  DICTATION_LANGUAGES,
  type DictationCatalogEntry,
  type DictationDownloadJob,
  type DictationInstalledModel,
  type DictationSettings as DictationSettingsValue,
} from "@/lib/dictation-types";

// Settings › Dictation: model catalog with downloads, the language/backend/
// threads choices, and the history switch. The panel is a plain section like
// General (no scopes: everything it edits lives in ~/.pi/agent).

interface DictationStatusResponse {
  settings: DictationSettingsValue;
  catalog: readonly DictationCatalogEntry[];
  installed: DictationInstalledModel[];
  jobs: DictationDownloadJob[];
  storageDir: string;
  ffmpeg: { available: boolean; version: string | null };
  backends: string[];
  historyCount: number;
}

const POLL_WHILE_DOWNLOADING_MS = 1500;

export function DictationSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DictationStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dictation");
      const data = await response.json() as DictationStatusResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setStatus(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a download runs, so progress bars move without a store.
  useEffect(() => {
    if (!status?.jobs.some((job) => job.status === "downloading")) return;
    const timer = setTimeout(() => void refresh(), POLL_WHILE_DOWNLOADING_MS);
    return () => clearTimeout(timer);
  }, [refresh, status]);

  const saveSettings = useCallback(async (changes: Partial<DictationSettingsValue>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/dictation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await response.json() as { settings?: DictationSettingsValue; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const modelAction = useCallback(async (id: string, action: "download" | "cancel" | "delete") => {
    setBusyModel(id);
    setError(null);
    try {
      const response = await fetch("/api/dictation/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyModel(null);
    }
  }, [refresh]);

  const clearHistory = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/dictation/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const smallButton = {
    padding: "4px 10px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 12,
    lineHeight: 1.4,
  } as const;

  const selectStyle = {
    padding: "5px 8px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: 12,
  } as const;

  const jobFor = (id: string): DictationDownloadJob | undefined => status?.jobs.find((job) => job.id === id);

  const modelRow = (entry: { id: string; label: string; sizeBytes?: number; custom?: boolean; notes?: string; languages?: "multilingual" | "en"; recommended?: boolean }, installed: DictationInstalledModel | undefined) => {
    const job = jobFor(entry.id);
    const downloading = job?.status === "downloading";
    const selected = status?.settings.model === entry.id;
    const percent = downloading && job && job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : null;
    return (
      <div
        key={entry.id}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "8px 0",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: selected ? 600 : 400, color: "var(--text)" }}>{entry.label}</span>
          {entry.recommended && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid color-mix(in srgb, var(--accent) 45%, transparent)", color: "var(--accent)" }}>{t("settings.dictationRecommended")}</span>}
          {entry.languages && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--border)", color: "var(--text-dim)" }}>{entry.languages === "en" ? t("settings.dictationEnglishOnly") : t("settings.dictationMultilingual")}</span>}
          {selected && <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, background: "var(--bg-selected)", color: "var(--text-muted)" }}>{t("settings.dictationInUse")}</span>}
          <span style={{ flex: 1 }} />
          {selected ? null : installed && (
            <button type="button" style={smallButton} disabled={saving} onClick={() => void saveSettings({ model: entry.id })}>
              {t("settings.dictationUse")}
            </button>
          )}
          {installed && (
            <button type="button" style={{ ...smallButton, color: "var(--text-dim)" }} disabled={busyModel === entry.id} onClick={() => void modelAction(entry.id, "delete")}>
              {t("settings.dictationDelete")}
            </button>
          )}
          {!installed && !entry.custom && (
            downloading ? (
              <button type="button" style={{ ...smallButton, color: "var(--text-dim)" }} onClick={() => void modelAction(entry.id, "cancel")}>
                {t("settings.dictationCancelDownload")}
              </button>
            ) : (
              <button type="button" style={smallButton} disabled={busyModel === entry.id} onClick={() => void modelAction(entry.id, "download")}>
                {t("settings.dictationDownload")}
              </button>
            )
          )}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          {typeof entry.sizeBytes === "number" && entry.sizeBytes > 0 && (
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{formatDictationBytes(entry.sizeBytes)}</span>
          )}
          {entry.notes && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{entry.notes}</span>}
          {job?.status === "error" && job.error && (
            <span style={{ fontSize: 11, color: "#ef4444", overflowWrap: "anywhere" }}>{job.error}</span>
          )}
        </div>
        {percent !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 4, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden" }}>
              <div style={{ width: `${percent}%`, height: "100%", background: "var(--accent)", transition: "width 0.4s" }} />
            </div>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", minWidth: 64, textAlign: "right" }}>
              {formatDictationBytes(job!.received)} / {formatDictationBytes(job!.total)}
            </span>
          </div>
        )}
      </div>
    );
  };

  const customModels = status?.installed.filter((entry) => entry.custom) ?? [];
  const installedById = new Map((status?.installed ?? []).map((entry) => [entry.id, entry]));
  const settings = status?.settings;

  return (
    <div className="settings-general">
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.dictation")}</h3>
        <p className="settings-general-description">{t("settings.dictationDescription")}</p>
        {status && !status.ffmpeg.available && (
          <p role="alert" className="settings-general-error">{t("settings.dictationFfmpegMissing")}</p>
        )}
        {status?.ffmpeg.available && status.ffmpeg.version && (
          <p className="settings-general-description" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>ffmpeg {status.ffmpeg.version}</p>
        )}
        {error && <p role="alert" className="settings-general-error">{error}</p>}
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.dictationModels")}</h3>
        <p className="settings-general-description">{t("settings.dictationModelsDescription")}</p>
        <div>
          {(status?.catalog ?? []).map((entry) => modelRow(entry, installedById.get(entry.id)))}
        </div>

        {customModels.length > 0 && (
          <>
            <h3 className="settings-general-heading" style={{ marginTop: 18 }}>{t("settings.dictationCustomModels")}</h3>
            <p className="settings-general-description">{t("settings.dictationCustomModelsDescription")}</p>
            <div>
              {customModels.map((entry) => modelRow({ ...entry, label: entry.file }, entry))}
            </div>
          </>
        )}

        <p className="settings-general-description" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          <span>{t("settings.dictationStorageDir")}:</span>
          <span style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{status?.storageDir ?? "—"}</span>
        </p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.dictationLanguage")}</h3>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.dictationLanguage")}</span>
            <select
              aria-label={t("settings.dictationLanguage")}
              value={settings?.language ?? "auto"}
              disabled={saving}
              style={selectStyle}
              onChange={(e) => void saveSettings({ language: e.target.value })}
            >
              <option value="auto">{t("settings.dictationLanguageAuto")}</option>
              {DICTATION_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>{language.label} ({language.code})</option>
              ))}
            </select>
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.dictationBackend")}</span>
            <select
              aria-label={t("settings.dictationBackend")}
              value={settings?.backend ?? "auto"}
              disabled={saving}
              style={selectStyle}
              onChange={(e) => void saveSettings({ backend: e.target.value as DictationSettingsValue["backend"] })}
            >
              {(status?.backends ?? ["auto", "cpu"]).map((backend) => (
                <option key={backend} value={backend}>{backend}</option>
              ))}
            </select>
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.dictationThreads")}</span>
            <input
              type="number"
              min={0}
              max={128}
              step={1}
              aria-label={t("settings.dictationThreads")}
              value={settings?.threads ?? 0}
              disabled={saving}
              style={{ ...selectStyle, width: 90, fontFamily: "var(--font-mono)" }}
              onBlur={(e) => {
                const threads = Math.max(0, Math.min(128, Math.floor(Number(e.target.value) || 0)));
                if (threads !== (settings?.threads ?? 0)) void saveSettings({ threads });
              }}
            />
          </div>
        </div>
        <p className="settings-general-description">{t("settings.dictationThreadsAuto")} = 0</p>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.dictationHistorySection")}</h3>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.dictationHistoryToggle")}</span>
            <ConfigSwitch
              checked={settings?.historyEnabled ?? true}
              loading={!status || saving}
              label={t("settings.dictationHistoryToggle")}
              onChange={(enabled) => void saveSettings({ historyEnabled: enabled })}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.dictationHistorySection")}</span>
            <button
              type="button"
              style={smallButton}
              disabled={saving || !status || status.historyCount === 0}
              onClick={() => void clearHistory()}
            >
              {t("settings.dictationHistoryClear")}
            </button>
          </div>
        </div>
        <p className="settings-general-description">{t("settings.dictationHistoryNote")}</p>
      </section>
    </div>
  );
}

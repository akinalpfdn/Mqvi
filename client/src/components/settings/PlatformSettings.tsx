/**
 * PlatformSettings — Platform admin LiveKit instance yönetim paneli.
 *
 * Two-panel layout:
 * - Sol: Instance listesi (URL + kapasite)
 * - Sağ: Create/Edit form
 *
 * Sadece is_platform_admin = true olan kullanıcılara görünür.
 * Backend PlatformAdminMiddleware ile korunur.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import {
  listLiveKitInstances,
  createLiveKitInstance,
  updateLiveKitInstance,
  deleteLiveKitInstance,
  getLiveKitInstanceMetrics,
} from "../../api/admin";
import type { LiveKitInstanceAdmin, LiveKitInstanceMetrics } from "../../types";

function PlatformSettings() {
  return <LiveKitTab />;
}

// ═══════════════════════════════════════════════════════
// LiveKit Instances Tab (mevcut işlevsellik)
// ═══════════════════════════════════════════════════════

function LiveKitTab() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const tRef = useRef(t);
  tRef.current = t;

  // ─── State ───
  const [instances, setInstances] = useState<LiveKitInstanceAdmin[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formUrl, setFormUrl] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formApiSecret, setFormApiSecret] = useState("");
  const [formMaxServers, setFormMaxServers] = useState(0);

  // Delete migration target
  const [migrateTargetId, setMigrateTargetId] = useState("");

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId]
  );

  // ─── Fetch ───
  const fetchInstances = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await listLiveKitInstances();
      if (res.success && res.data) {
        setInstances(res.data);
      } else {
        addToast("error", res.error ?? tRef.current("platformInstanceLoadError"));
      }
    } catch {
      addToast("error", tRef.current("platformInstanceLoadError"));
    } finally {
      setIsLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  useEffect(() => {
    if (isCreating) {
      setFormUrl("");
      setFormApiKey("");
      setFormApiSecret("");
      setFormMaxServers(0);
    } else {
      const inst = instances.find((i) => i.id === selectedId);
      if (inst) {
        setFormUrl(inst.url);
        setFormApiKey("");
        setFormApiSecret("");
        setFormMaxServers(inst.max_servers);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, isCreating]);

  // ─── Create ───
  async function handleCreate() {
    if (!formUrl || !formApiKey || !formApiSecret) return;
    try {
      setIsSaving(true);
      const res = await createLiveKitInstance({
        url: formUrl,
        api_key: formApiKey,
        api_secret: formApiSecret,
        max_servers: formMaxServers,
      });
      if (res.success && res.data) {
        setInstances((prev) => [...prev, res.data!]);
        setIsCreating(false);
        setSelectedId(res.data.id);
        addToast("success", t("platformInstanceCreated"));
      } else {
        addToast("error", res.error ?? t("platformInstanceCreateError"));
      }
    } catch {
      addToast("error", t("platformInstanceCreateError"));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Update ───
  async function handleUpdate() {
    if (selectedId === null) {
      addToast("error", t("platformNoInstanceSelected"));
      return;
    }

    const current = instances.find((i) => i.id === selectedId);
    if (!current) {
      addToast("error", t("platformNoInstanceSelected"));
      return;
    }

    const body: Record<string, string | number> = {};
    if (formUrl !== current.url) body.url = formUrl;
    if (formApiKey) body.api_key = formApiKey;
    if (formApiSecret) body.api_secret = formApiSecret;
    if (formMaxServers !== current.max_servers)
      body.max_servers = formMaxServers;

    if (Object.keys(body).length === 0) {
      addToast("info", t("platformNoChanges"));
      return;
    }

    try {
      setIsSaving(true);
      const res = await updateLiveKitInstance(selectedId, body);
      if (res.success && res.data) {
        const updated = res.data;
        setInstances((prev) =>
          prev.map((i) => (i.id === updated.id ? updated : i))
        );
        addToast("success", t("platformInstanceUpdated"));
      } else {
        addToast("error", res.error ?? t("platformInstanceUpdateError"));
      }
    } catch {
      addToast("error", t("platformInstanceUpdateError"));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Delete ───
  async function handleDelete() {
    if (!selectedInstance) return;

    if (selectedInstance.server_count > 0) {
      if (!migrateTargetId) {
        addToast("error", t("platformMigrateTargetRequired"));
        return;
      }
    }

    const ok = await confirm({
      message:
        selectedInstance.server_count > 0
          ? t("platformDeleteMigrateConfirm", {
              count: selectedInstance.server_count,
            })
          : t("platformDeleteConfirm"),
      danger: true,
    });
    if (!ok) return;

    try {
      await deleteLiveKitInstance(
        selectedInstance.id,
        selectedInstance.server_count > 0 ? migrateTargetId : undefined
      );
      setInstances((prev) => prev.filter((i) => i.id !== selectedInstance.id));
      setSelectedId(null);
      setMigrateTargetId("");
      addToast("success", t("platformInstanceDeleted"));
    } catch {
      addToast("error", t("platformInstanceDeleteError"));
    }
  }

  // ─── Helpers ───
  function formatCapacity(inst: LiveKitInstanceAdmin) {
    if (inst.max_servers === 0) {
      return t("platformInstanceCapacityUnlimited", {
        count: inst.server_count,
      });
    }
    return t("platformInstanceCapacity", {
      count: inst.server_count,
      max: inst.max_servers,
    });
  }

  // ─── Render ───
  return (
    <div className="channel-settings-wrapper" style={{ flex: 1, minHeight: 0 }}>
      {/* ── Sol Panel: Instance Listesi ── */}
      <div className="role-list">
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {t("platformLiveKitInstances")}
          </span>
          <button
            className="settings-btn channel-settings-header-btn"
            onClick={() => {
              setIsCreating(true);
              setSelectedId(null);
            }}
          >
            +
          </button>
        </div>

        <div className="channel-settings-ch-list">
          {isLoading && <p className="no-channel">{t("loading")}</p>}

          {!isLoading && instances.length === 0 && (
            <p className="no-channel">{t("platformNoInstances")}</p>
          )}

          {instances.map((inst) => (
            <div
              key={inst.id}
              className={`role-list-item platform-instance-item${selectedId === inst.id ? " active" : ""}`}
              onClick={() => {
                setSelectedId(inst.id);
                setIsCreating(false);
              }}
            >
              <span className="role-list-name" title={inst.url}>
                {inst.url}
              </span>
              <span className="platform-instance-capacity">
                {formatCapacity(inst)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Sağ Panel: Form ── */}
      <div className="settings-content channel-settings-right">
        {isCreating ? (
          <CreateForm
            t={t}
            formUrl={formUrl}
            setFormUrl={setFormUrl}
            formApiKey={formApiKey}
            setFormApiKey={setFormApiKey}
            formApiSecret={formApiSecret}
            setFormApiSecret={setFormApiSecret}
            formMaxServers={formMaxServers}
            setFormMaxServers={setFormMaxServers}
            isSaving={isSaving}
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
          />
        ) : selectedInstance ? (
          <EditForm
            t={t}
            instance={selectedInstance}
            formUrl={formUrl}
            setFormUrl={setFormUrl}
            formApiKey={formApiKey}
            setFormApiKey={setFormApiKey}
            formApiSecret={formApiSecret}
            setFormApiSecret={setFormApiSecret}
            formMaxServers={formMaxServers}
            setFormMaxServers={setFormMaxServers}
            isSaving={isSaving}
            onSave={handleUpdate}
            onDelete={handleDelete}
            migrateTargetId={migrateTargetId}
            setMigrateTargetId={setMigrateTargetId}
            otherInstances={instances.filter(
              (i) => i.id !== selectedInstance.id
            )}
          />
        ) : (
          <div className="no-channel">
            {t("platformNoInstanceSelected")}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Create Form
// ═══════════════════════════════════════════════════════

type CreateFormProps = {
  t: (key: string, opts?: Record<string, unknown>) => string;
  formUrl: string;
  setFormUrl: (v: string) => void;
  formApiKey: string;
  setFormApiKey: (v: string) => void;
  formApiSecret: string;
  setFormApiSecret: (v: string) => void;
  formMaxServers: number;
  setFormMaxServers: (v: number) => void;
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
};

function CreateForm({
  t,
  formUrl,
  setFormUrl,
  formApiKey,
  setFormApiKey,
  formApiSecret,
  setFormApiSecret,
  formMaxServers,
  setFormMaxServers,
  isSaving,
  onSave,
  onCancel,
}: CreateFormProps) {
  const canSave = formUrl && formApiKey && formApiSecret;

  return (
    <div className="channel-perm-section">
      <h2 className="settings-section-title channel-settings-right-title">
        {t("platformAddInstance")}
      </h2>

      <div className="settings-field">
        <label className="settings-label">{t("platformInstanceUrl")}</label>
        <input
          className="settings-input"
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          placeholder={t("platformInstanceUrlPlaceholder")}
        />
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("platformInstanceApiKey")}</label>
        <input
          className="settings-input"
          value={formApiKey}
          onChange={(e) => setFormApiKey(e.target.value)}
          placeholder={t("platformInstanceApiKeyPlaceholder")}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label">
          {t("platformInstanceApiSecret")}
        </label>
        <input
          className="settings-input"
          type="password"
          value={formApiSecret}
          onChange={(e) => setFormApiSecret(e.target.value)}
          placeholder={t("platformInstanceApiSecretPlaceholder")}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label">
          {t("platformInstanceMaxServers")}
        </label>
        <input
          className="settings-input"
          type="number"
          min={0}
          value={formMaxServers}
          onChange={(e) => setFormMaxServers(parseInt(e.target.value, 10) || 0)}
        />
        <span className="settings-hint">
          {t("platformInstanceMaxServersHint")}
        </span>
      </div>

      <div className="settings-btn-row">
        <button
          className="settings-btn"
          disabled={!canSave || isSaving}
          onClick={onSave}
        >
          {isSaving ? t("saving") : t("platformAddInstance")}
        </button>
        <button className="settings-btn settings-btn-secondary" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Edit Form
// ═══════════════════════════════════════════════════════

type EditFormProps = {
  t: (key: string, opts?: Record<string, unknown>) => string;
  instance: LiveKitInstanceAdmin;
  formUrl: string;
  setFormUrl: (v: string) => void;
  formApiKey: string;
  setFormApiKey: (v: string) => void;
  formApiSecret: string;
  setFormApiSecret: (v: string) => void;
  formMaxServers: number;
  setFormMaxServers: (v: number) => void;
  isSaving: boolean;
  onSave: () => void;
  onDelete: () => void;
  migrateTargetId: string;
  setMigrateTargetId: (v: string) => void;
  otherInstances: LiveKitInstanceAdmin[];
};

function EditForm({
  t,
  instance,
  formUrl,
  setFormUrl,
  formApiKey,
  setFormApiKey,
  formApiSecret,
  setFormApiSecret,
  formMaxServers,
  setFormMaxServers,
  isSaving,
  onSave,
  onDelete,
  migrateTargetId,
  setMigrateTargetId,
  otherInstances,
}: EditFormProps) {
  const hasChanges =
    formUrl !== instance.url ||
    formApiKey !== "" ||
    formApiSecret !== "" ||
    formMaxServers !== instance.max_servers;

  return (
    <div className="channel-perm-section">
      <h2 className="settings-section-title channel-settings-right-title">
        {t("platformEditInstance")}
      </h2>

      <div className="settings-field">
        <label className="settings-label">{t("platformInstanceUrl")}</label>
        <input
          className="settings-input"
          value={formUrl}
          onChange={(e) => setFormUrl(e.target.value)}
          placeholder={t("platformInstanceUrlPlaceholder")}
        />
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("platformInstanceApiKey")}</label>
        <input
          className="settings-input"
          value={formApiKey}
          onChange={(e) => setFormApiKey(e.target.value)}
          placeholder={t("platformInstanceApiKeyPlaceholder")}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <span className="settings-hint">{t("platformCredentialsHint")}</span>
      </div>

      <div className="settings-field">
        <label className="settings-label">
          {t("platformInstanceApiSecret")}
        </label>
        <input
          className="settings-input"
          type="password"
          value={formApiSecret}
          onChange={(e) => setFormApiSecret(e.target.value)}
          placeholder={t("platformInstanceApiSecretPlaceholder")}
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      <div className="settings-field">
        <label className="settings-label">
          {t("platformInstanceMaxServers")}
        </label>
        <input
          className="settings-input"
          type="number"
          min={0}
          value={formMaxServers}
          onChange={(e) => setFormMaxServers(parseInt(e.target.value, 10) || 0)}
        />
        <span className="settings-hint">
          {t("platformInstanceMaxServersHint")}
        </span>
      </div>

      <div className="settings-field">
        <label className="settings-label">
          {t("platformInstanceServerCount")}
        </label>
        <span className="settings-value">{instance.server_count}</span>
      </div>

      <div className="settings-btn-row">
        <button
          className="settings-btn"
          disabled={!hasChanges || isSaving}
          onClick={onSave}
        >
          {isSaving ? t("saving") : t("save")}
        </button>
      </div>

      {/* ── Metrics Panel ── */}
      <MetricsPanel instanceId={instance.id} t={t} />

      {/* ── Danger Zone ── */}
      <div className="dz-separator" />
      <div className="dz-section">
        <h2 className="dz-title">{t("dangerZone")}</h2>

        <div className="dz-card">
          <h3 className="dz-card-title">{t("platformDeleteInstance")}</h3>
          <p className="dz-card-desc">{t("platformDeleteDesc")}</p>

          {instance.server_count > 0 && (
            <div className="settings-field">
              <label className="settings-label">{t("platformMigrateTarget")}</label>
              <select
                className="settings-select"
                value={migrateTargetId}
                onChange={(e) => setMigrateTargetId(e.target.value)}
              >
                <option value="">{t("platformSelectTarget")}</option>
                {otherInstances.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.url} ({other.server_count}
                    {other.max_servers > 0 ? `/${other.max_servers}` : ""})
                  </option>
                ))}
              </select>
            </div>
          )}

          <button className="dz-btn" onClick={onDelete}>
            {t("platformDeleteInstance")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// Metrics Panel — Prometheus /metrics monitoring
// ═══════════════════════════════════════════════════════

type MetricsPanelProps = {
  instanceId: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
};

function MetricsPanel({ instanceId, t }: MetricsPanelProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [metrics, setMetrics] = useState<LiveKitInstanceMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      setIsLoading(true);
      const res = await getLiveKitInstanceMetrics(instanceId);
      if (res.success && res.data) {
        setMetrics(res.data);
      } else {
        addToast("error", res.error ?? t("platformMetricsLoadError"));
      }
    } catch {
      addToast("error", t("platformMetricsLoadError"));
    } finally {
      setIsLoading(false);
    }
  }, [instanceId, addToast, t]);

  // Instance değiştiğinde otomatik fetch
  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  return (
    <>
      <div className="dz-separator" />
      <div className="metrics-section">
        <div className="metrics-header">
          <h2 className="settings-section-title">{t("platformMetrics")}</h2>
          <button
            className="settings-btn settings-btn-secondary metrics-refresh-btn"
            onClick={fetchMetrics}
            disabled={isLoading}
          >
            {isLoading ? t("platformMetricsRefreshing") : t("platformMetricsRefresh")}
          </button>
        </div>

        {metrics && !metrics.available && (
          <p className="metrics-unavailable">
            {t("platformMetricsUnavailable")}
          </p>
        )}

        {metrics?.available && (
          <>
            <p className="metrics-timestamp">
              {t("platformMetricsLastUpdated", {
                time: new Date(metrics.fetched_at).toLocaleTimeString(),
              })}
            </p>

            <div className="metrics-grid">
              {/* CPU */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsCPULoad")}</span>
                <span className="metrics-card-value">
                  {(metrics.cpu_load * 100).toFixed(1)}%
                </span>
                <span className="metrics-card-sub">
                  {t("platformMetricsCPUCores", { count: metrics.num_cpus })}
                </span>
              </div>

              {/* Memory */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsMemoryUsed")}</span>
                <span className="metrics-card-value">
                  {formatBytes(metrics.memory_used)}
                </span>
                <span className="metrics-card-sub">
                  {t("platformMetricsMemoryLoad")}: {(metrics.memory_load * 100).toFixed(1)}%
                </span>
              </div>

              {/* Rooms */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsRooms")}</span>
                <span className="metrics-card-value">{metrics.room_count}</span>
              </div>

              {/* Participants */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsParticipants")}</span>
                <span className="metrics-card-value">{metrics.participant_count}</span>
              </div>

              {/* Tracks */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsTracks")}</span>
                <span className="metrics-card-value">
                  {metrics.track_publish_count} / {metrics.track_subscribe_count}
                </span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPublished")} / {t("platformMetricsSubscribed")}
                </span>
              </div>

              {/* NACK */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsNack")}</span>
                <span className="metrics-card-value">{metrics.nack_total.toLocaleString()}</span>
              </div>

              {/* Bandwidth In */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsBytesIn")}</span>
                <span className="metrics-card-value">{formatBytes(metrics.bytes_in)}</span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPacketsIn")}: {metrics.packets_in.toLocaleString()}
                </span>
              </div>

              {/* Bandwidth Out */}
              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsBytesOut")}</span>
                <span className="metrics-card-value">{formatBytes(metrics.bytes_out)}</span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPacketsOut")}: {metrics.packets_out.toLocaleString()}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Byte değerini okunabilir formata çevir (KB/MB/GB) */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export default PlatformSettings;

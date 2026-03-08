/** PlatformSettings — Platform admin LiveKit instance management (CRUD + metrics). */

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  listLiveKitInstances,
  createLiveKitInstance,
  updateLiveKitInstance,
  deleteLiveKitInstance,
  getLiveKitInstanceMetrics,
  getLiveKitMetricsHistory,
  getLiveKitMetricsTimeSeries,
} from "../../api/admin";
import type {
  LiveKitInstanceAdmin,
  LiveKitInstanceMetrics,
  MetricsHistorySummary,
  MetricsTimeSeriesPoint,
} from "../../types";

function PlatformSettings() {
  return <LiveKitTab />;
}


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
  const [formHetznerServerID, setFormHetznerServerID] = useState("");

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
      setFormHetznerServerID("");
    } else {
      const inst = instances.find((i) => i.id === selectedId);
      if (inst) {
        setFormUrl(inst.url);
        setFormApiKey("");
        setFormApiSecret("");
        setFormMaxServers(inst.max_servers);
        setFormHetznerServerID(inst.hetzner_server_id ?? "");
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
        hetzner_server_id: formHetznerServerID || undefined,
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
    if (formHetznerServerID !== (current.hetzner_server_id ?? ""))
      body.hetzner_server_id = formHetznerServerID;

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
      {/* Left Panel: Instance List */}
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

      {/* Right Panel: Form + Monitoring */}
      <div className="channel-settings-right" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
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
            formHetznerServerID={formHetznerServerID}
            setFormHetznerServerID={setFormHetznerServerID}
            isSaving={isSaving}
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
          />
        ) : selectedInstance ? (
          <div className="lk-edit-layout">
            <div className="lk-edit-form">
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
                formHetznerServerID={formHetznerServerID}
                setFormHetznerServerID={setFormHetznerServerID}
                isSaving={isSaving}
                onSave={handleUpdate}
                onDelete={handleDelete}
                migrateTargetId={migrateTargetId}
                setMigrateTargetId={setMigrateTargetId}
                otherInstances={instances.filter(
                  (i) => i.id !== selectedInstance.id
                )}
              />
            </div>
            <div className="lk-edit-monitoring">
              <MetricsPanel instanceId={selectedInstance.id} t={t} />
            </div>
          </div>
        ) : (
          <div className="no-channel">
            {t("platformNoInstanceSelected")}
          </div>
        )}
      </div>
    </div>
  );
}


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
  formHetznerServerID: string;
  setFormHetznerServerID: (v: string) => void;
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
  formHetznerServerID,
  setFormHetznerServerID,
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

      <div className="settings-field">
        <label className="settings-label">
          {t("platformHetznerServerId")}
        </label>
        <input
          className="settings-input"
          value={formHetznerServerID}
          onChange={(e) => setFormHetznerServerID(e.target.value)}
          placeholder={t("platformHetznerServerIdPlaceholder")}
        />
        <span className="settings-hint">
          {t("platformHetznerServerIdHint")}
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
  formHetznerServerID: string;
  setFormHetznerServerID: (v: string) => void;
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
  formHetznerServerID,
  setFormHetznerServerID,
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
    formMaxServers !== instance.max_servers ||
    formHetznerServerID !== (instance.hetzner_server_id ?? "");

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
          {t("platformHetznerServerId")}
        </label>
        <input
          className="settings-input"
          value={formHetznerServerID}
          onChange={(e) => setFormHetznerServerID(e.target.value)}
          placeholder={t("platformHetznerServerIdPlaceholder")}
        />
        <span className="settings-hint">
          {t("platformHetznerServerIdHint")}
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


type MetricsPanelProps = {
  instanceId: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
};

function MetricsPanel({ instanceId, t }: MetricsPanelProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [metrics, setMetrics] = useState<LiveKitInstanceMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // ─── History state ───
  const [selectedPeriod, setSelectedPeriod] = useState<"24h" | "7d" | "30d">("24h");
  const [historySummary, setHistorySummary] = useState<MetricsHistorySummary | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);

  // ─── Time-series chart state ───
  const [timeSeries, setTimeSeries] = useState<MetricsTimeSeriesPoint[]>([]);
  const [isChartLoading, setIsChartLoading] = useState(false);

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

  const fetchHistory = useCallback(async (period: "24h" | "7d" | "30d") => {
    try {
      setIsHistoryLoading(true);
      const res = await getLiveKitMetricsHistory(instanceId, period);
      if (res.success && res.data) {
        setHistorySummary(res.data);
      } else {
        addToast("error", res.error ?? t("platformMetricsHistoryLoadError"));
      }
    } catch {
      addToast("error", t("platformMetricsHistoryLoadError"));
    } finally {
      setIsHistoryLoading(false);
    }
  }, [instanceId, addToast, t]);

  const fetchTimeSeries = useCallback(async (period: "24h" | "7d" | "30d") => {
    try {
      setIsChartLoading(true);
      const res = await getLiveKitMetricsTimeSeries(instanceId, period);
      if (res.success && res.data) {
        setTimeSeries(res.data);
      }
    } catch {
      // chart data is optional — fail silently
    } finally {
      setIsChartLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    fetchHistory(selectedPeriod);
    fetchTimeSeries(selectedPeriod);
  }, [fetchHistory, fetchTimeSeries, selectedPeriod]);

  const handlePeriodChange = useCallback((period: "24h" | "7d" | "30d") => {
    setSelectedPeriod(period);
  }, []);

  return (
    <>
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
              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsCPU")}</span>
                  <span className="metrics-card-value">
                    {metrics.cpu_pct.toFixed(1)}%
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsBwIn")}</span>
                  <span className="metrics-card-value">
                    {formatBps(metrics.bw_in_bps)}
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              {metrics.hetzner_avail && (
                <div className="metrics-card">
                  <span className="metrics-card-label">{t("platformMetricsBwOut")}</span>
                  <span className="metrics-card-value">
                    {formatBps(metrics.bw_out_bps)}
                  </span>
                  <span className="metrics-card-sub">Hetzner</span>
                </div>
              )}

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsGoroutines")}</span>
                <span className="metrics-card-value">
                  {metrics.goroutines.toLocaleString()}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsMemoryUsed")}</span>
                <span className="metrics-card-value">
                  {formatBytes(metrics.memory_used)}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsRooms")}</span>
                <span className="metrics-card-value">{metrics.room_count}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsParticipants")}</span>
                <span className="metrics-card-value">{metrics.participant_count}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsTracks")}</span>
                <span className="metrics-card-value">
                  {metrics.track_publish_count} / {metrics.track_subscribe_count}
                </span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPublished")} / {t("platformMetricsSubscribed")}
                </span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsNack")}</span>
                <span className="metrics-card-value">{metrics.nack_total.toLocaleString()}</span>
              </div>

              <div className="metrics-card">
                <span className="metrics-card-label">{t("platformMetricsBytesIn")}</span>
                <span className="metrics-card-value">{formatBytes(metrics.bytes_in)}</span>
                <span className="metrics-card-sub">
                  {t("platformMetricsPacketsIn")}: {metrics.packets_in.toLocaleString()}
                </span>
              </div>

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

      {/* ─── Capacity History Section ─── */}
      <div className="dz-separator" />
      <div className="metrics-section">
        <div className="metrics-header">
          <h2 className="settings-section-title">{t("platformMetricsHistory")}</h2>
          <div className="metrics-period-toggle">
            {(["24h", "7d", "30d"] as const).map((period) => (
              <button
                key={period}
                className={`metrics-period-btn${selectedPeriod === period ? " active" : ""}`}
                onClick={() => handlePeriodChange(period)}
                disabled={isHistoryLoading}
              >
                {t(`platformMetricsPeriod${period}`)}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Time-Series Charts ─── */}
        <MetricsChart
          data={timeSeries}
          period={selectedPeriod}
          isLoading={isChartLoading}
          t={t}
        />

        {isHistoryLoading && !historySummary && (
          <p className="metrics-timestamp">{t("platformMetricsRefreshing")}</p>
        )}

        {historySummary && historySummary.sample_count === 0 && (
          <p className="metrics-unavailable">
            {t("platformMetricsHistoryNoData")}
          </p>
        )}

        {historySummary && historySummary.sample_count > 0 && (
          <div className="metrics-grid">
            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakParticipants")}</span>
              <span className="metrics-card-value">{historySummary.peak_participants}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgParticipants")}</span>
              <span className="metrics-card-value">{historySummary.avg_participants.toFixed(1)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakRooms")}</span>
              <span className="metrics-card-value">{historySummary.peak_rooms}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakCPU")}</span>
              <span className="metrics-card-value">{historySummary.peak_cpu_pct.toFixed(1)}%</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgCPU")}</span>
              <span className="metrics-card-value">{historySummary.avg_cpu_pct.toFixed(1)}%</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsPeakMemory")}</span>
              <span className="metrics-card-value">{formatBytes(historySummary.peak_memory_bytes)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgBandwidthIn")}</span>
              <span className="metrics-card-value">{formatBps(historySummary.avg_bandwidth_in_bps)}</span>
            </div>

            <div className="metrics-card">
              <span className="metrics-card-label">{t("platformMetricsAvgBandwidthOut")}</span>
              <span className="metrics-card-value">{formatBps(historySummary.avg_bandwidth_out_bps)}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatBps(bytesPerSec: number): string {
  const bps = bytesPerSec * 8;
  if (bps === 0) return "0 bps";
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  const i = Math.floor(Math.log(bps) / Math.log(1000));
  const val = bps / Math.pow(1000, i);
  return `${val.toFixed(1)} ${units[Math.min(i, units.length - 1)]}`;
}


type MetricsChartProps = {
  data: MetricsTimeSeriesPoint[];
  period: "24h" | "7d" | "30d";
  isLoading: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
};

function MetricsChart({ data, period, isLoading, t }: MetricsChartProps) {
  if (isLoading && data.length === 0) {
    return (
      <div className="metrics-chart-loading">
        <div className="metrics-chart-skeleton" />
        <div className="metrics-chart-skeleton" />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <p className="metrics-unavailable">{t("platformMetricsChartNoData")}</p>
    );
  }

  return (
    <div className="metrics-chart-container">
      {/* CPU Chart */}
      <div className="metrics-chart-block">
        <span className="metrics-chart-title">{t("platformMetricsChartCPU")}</span>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--red)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--red)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--b1)" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              tickFormatter={(v: string) => formatXAxis(v, period)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              width={45}
              domain={[0, "auto"]}
            />
            <Tooltip content={<ChartTooltip period={period} valueFormatter={(v) => `${v.toFixed(1)}%`} />} />
            <Area
              type="monotone"
              dataKey="cpu_pct"
              stroke="var(--red)"
              fill="url(#cpuGrad)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: "var(--red)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Bandwidth Chart */}
      <div className="metrics-chart-block">
        <span className="metrics-chart-title">{t("platformMetricsChartBandwidth")}</span>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="bwInGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--yellow)" stopOpacity={0.25} />
                <stop offset="95%" stopColor="var(--yellow)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="bwOutGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--red)" stopOpacity={0.15} />
                <stop offset="95%" stopColor="var(--red)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--b1)" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              tickFormatter={(v: string) => formatXAxis(v, period)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => formatBps(v)}
              tick={{ fill: "var(--t2)", fontSize: 13 }}
              axisLine={false}
              tickLine={false}
              width={55}
              domain={[0, "auto"]}
            />
            <Tooltip
              content={
                <ChartTooltip
                  period={period}
                  valueFormatter={(v) => formatBps(v)}
                  labelMap={{ bw_in: "In", bw_out: "Out" }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="bw_in"
              stroke="var(--yellow)"
              fill="url(#bwInGrad)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: "var(--yellow)" }}
            />
            <Area
              type="monotone"
              dataKey="bw_out"
              stroke="var(--red)"
              fill="url(#bwOutGrad)"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: "var(--red)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


type ChartTooltipProps = {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; color: string }>;
  label?: string;
  period: "24h" | "7d" | "30d";
  valueFormatter: (v: number) => string;
  labelMap?: Record<string, string>;
};

function ChartTooltip({ active, payload, label, period, valueFormatter, labelMap }: ChartTooltipProps) {
  if (!active || !payload || !label) return null;

  return (
    <div className="metrics-chart-tooltip">
      <span className="metrics-chart-tooltip-time">{formatXAxis(label, period)}</span>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="metrics-chart-tooltip-row">
          <span className="metrics-chart-tooltip-dot" style={{ background: entry.color }} />
          <span>{labelMap?.[entry.dataKey] ?? entry.dataKey}: {valueFormatter(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

function formatXAxis(ts: string, period: "24h" | "7d" | "30d"): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  if (period === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return (
    d.toLocaleDateString([], { month: "2-digit", day: "2-digit" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

export default PlatformSettings;

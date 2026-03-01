/**
 * PlatformSettings — Platform admin LiveKit instance yönetim paneli.
 *
 * Two-panel layout (RoleSettings pattern):
 * - Sol: Instance listesi (URL + kapasite göstergesi) + "Yeni Ekle" butonu
 * - Sağ: Instance oluşturma/düzenleme formu veya boş durum mesajı
 *
 * Sadece is_platform_admin = true olan kullanıcılara görünür.
 * Backend PlatformAdminMiddleware ile korunur.
 *
 * CSS class'ları: .channel-settings-wrapper (two-panel reuse),
 * .role-list, .role-list-item, .settings-section, .settings-field,
 * .settings-label, .settings-input, .settings-btn, .settings-btn-danger
 */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import {
  listLiveKitInstances,
  createLiveKitInstance,
  updateLiveKitInstance,
  deleteLiveKitInstance,
} from "../../api/admin";
import type { LiveKitInstanceAdmin } from "../../types";

function PlatformSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

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

  const selectedInstance = instances.find((i) => i.id === selectedId) ?? null;

  // ─── Fetch ───
  const fetchInstances = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await listLiveKitInstances();
      setInstances(data);
    } catch {
      addToast(t("platformInstanceLoadError"), "error");
    } finally {
      setIsLoading(false);
    }
  }, [addToast, t]);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  // ─── Formu doldur: seçili instance veya create mode ───
  useEffect(() => {
    if (isCreating) {
      setFormUrl("");
      setFormApiKey("");
      setFormApiSecret("");
      setFormMaxServers(0);
    } else if (selectedInstance) {
      setFormUrl(selectedInstance.url);
      setFormApiKey("");
      setFormApiSecret("");
      setFormMaxServers(selectedInstance.max_servers);
    }
  }, [selectedId, isCreating, selectedInstance]);

  // ─── Create ───
  async function handleCreate() {
    if (!formUrl || !formApiKey || !formApiSecret) return;
    try {
      setIsSaving(true);
      const created = await createLiveKitInstance({
        url: formUrl,
        api_key: formApiKey,
        api_secret: formApiSecret,
        max_servers: formMaxServers,
      });
      setInstances((prev) => [...prev, created]);
      setIsCreating(false);
      setSelectedId(created.id);
      addToast(t("platformInstanceCreated"), "success");
    } catch {
      addToast(t("platformInstanceCreateError"), "error");
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Update ───
  async function handleUpdate() {
    if (!selectedId) return;
    try {
      setIsSaving(true);
      const body: Record<string, string | number> = {};
      if (formUrl !== selectedInstance?.url) body.url = formUrl;
      if (formApiKey) body.api_key = formApiKey;
      if (formApiSecret) body.api_secret = formApiSecret;
      if (formMaxServers !== selectedInstance?.max_servers)
        body.max_servers = formMaxServers;

      if (Object.keys(body).length === 0) return;

      const updated = await updateLiveKitInstance(selectedId, body);
      setInstances((prev) =>
        prev.map((i) => (i.id === updated.id ? updated : i))
      );
      addToast(t("platformInstanceUpdated"), "success");
    } catch {
      addToast(t("platformInstanceUpdateError"), "error");
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Delete ───
  async function handleDelete() {
    if (!selectedInstance) return;

    if (selectedInstance.server_count > 0) {
      // Migration gerekli — target seçmeli
      if (!migrateTargetId) {
        addToast(t("platformMigrateTargetRequired"), "error");
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
      addToast(t("platformInstanceDeleted"), "success");
    } catch {
      addToast(t("platformInstanceDeleteError"), "error");
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
    <div className="channel-settings-wrapper">
      {/* ── Sol Panel: Instance Listesi ── */}
      <div className="role-list">
        <div className="role-list-header">
          <h2 className="settings-section-title">
            {t("platformLiveKitInstances")}
          </h2>
          <button
            className="settings-btn"
            onClick={() => {
              setIsCreating(true);
              setSelectedId(null);
            }}
          >
            {t("platformAddInstance")}
          </button>
        </div>

        {isLoading && <p className="no-channel">{t("loading")}</p>}

        {!isLoading && instances.length === 0 && (
          <p className="no-channel">{t("platformNoInstances")}</p>
        )}

        {instances.map((inst) => (
          <div
            key={inst.id}
            className={`role-list-item${selectedId === inst.id ? " active" : ""}`}
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
          <p className="no-channel">{t("platformNoInstanceSelected")}</p>
        )}
      </div>
    </div>
  );
}

// ─── Create Form ───

type CreateFormProps = {
  t: (key: string) => string;
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
    <div className="settings-section">
      <h2 className="settings-section-title">{t("platformAddInstance")}</h2>

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

      <div className="settings-field" style={{ flexDirection: "row", gap: 8 }}>
        <button
          className="settings-btn"
          disabled={!canSave || isSaving}
          onClick={onSave}
        >
          {isSaving ? t("saving") : t("platformAddInstance")}
        </button>
        <button className="settings-btn-secondary" onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

// ─── Edit Form ───

type EditFormProps = {
  t: (key: string) => string;
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
    <div className="settings-section">
      <h2 className="settings-section-title">{t("platformEditInstance")}</h2>

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

      <button
        className="settings-btn"
        disabled={!hasChanges || isSaving}
        onClick={onSave}
      >
        {isSaving ? t("saving") : t("save")}
      </button>

      {/* ── Danger Zone: Delete ── */}
      <div className="settings-section settings-danger-zone">
        <h3 className="settings-section-title settings-danger-title">
          {t("dangerZone")}
        </h3>

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

        <button className="settings-btn-danger" onClick={onDelete}>
          {t("platformDeleteInstance")}
        </button>
      </div>
    </div>
  );
}

export default PlatformSettings;

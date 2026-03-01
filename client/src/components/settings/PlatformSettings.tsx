/**
 * PlatformSettings — Platform admin LiveKit instance yönetim paneli.
 *
 * Two-panel layout (RoleSettings / ChannelSettings pattern):
 * - Sol: Instance listesi (URL + kapasite göstergesi) + "Sunucu Ekle" butonu
 * - Sağ: Instance oluşturma/düzenleme formu veya boş durum mesajı
 *
 * Sadece is_platform_admin = true olan kullanıcılara görünür.
 * Backend PlatformAdminMiddleware ile korunur.
 *
 * CSS class'ları: .channel-settings-wrapper, .channel-settings-header,
 * .channel-settings-header-label, .channel-settings-header-btn,
 * .channel-settings-ch-list, .role-list, .role-list-item,
 * .platform-instance-item, .platform-instance-capacity,
 * .channel-perm-section, .settings-section-title, .channel-settings-right-title,
 * .settings-field, .settings-label, .settings-input, .settings-select,
 * .settings-hint, .settings-value, .settings-btn, .settings-btn-row,
 * .dz-separator, .dz-section, .dz-title, .dz-card, .dz-card-title,
 * .dz-card-desc, .dz-btn
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
} from "../../api/admin";
import type { LiveKitInstanceAdmin } from "../../types";

function PlatformSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // t referansı her renderda değişebilir (react-i18next).
  // fetchInstances'ın gereksiz yeniden oluşturulmasını önlemek için ref kullanıyoruz.
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

  // useMemo: instances.find() her renderda yeni referans döner.
  // Bu yüzden effect dependency'lerinde kararsız davranır. Memoize edince
  // sadece instances veya selectedId değiştiğinde yeni referans oluşur.
  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId]
  );

  // ─── Fetch ───
  // addToast zustanddan gelir (stabil referans). t ise ref üzerinden erişilir.
  // Böylece fetchInstances SADECE mount'ta çalışır, t değişince tekrar çalışmaz.
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

  // ─── Formu doldur: seçili instance veya create mode ───
  // Dependency: selectedId (primitive — stabil) ve isCreating.
  // selectedInstance yerine selectedId kullanıyoruz çünkü instances refetch olduğunda
  // selectedInstance yeni referans alır ve bu effect gereksiz yere tekrar çalışırdı,
  // kullanıcının form'a girdiği API key/secret değerlerini sıfırlardı.
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
    // Strict null check: selectedId boş string ("") olabilir (eski DB bug'ı).
    // !selectedId boş string'de de true döner, bu yüzden === null kullanıyoruz.
    if (selectedId === null) {
      addToast("error", t("platformNoInstanceSelected"));
      return;
    }

    // selectedInstance yerine instances'dan taze bul — closure staleness koruması.
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
    <div className="channel-settings-wrapper">
      {/* ── Sol Panel: Instance Listesi ── */}
      <div className="role-list">
        {/* Header — ChannelSettings / RoleSettings pattern */}
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

        {/* Instance listesi — scrollable wrapper */}
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

// ─── Create Form ───

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

// ─── Edit Form ───

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

      {/* ── Danger Zone — ServerGeneralSettings pattern ── */}
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

export default PlatformSettings;

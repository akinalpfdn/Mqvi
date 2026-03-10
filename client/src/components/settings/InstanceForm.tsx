/** InstanceForm — Unified create/edit form for LiveKit instances. */

import { useTranslation } from "react-i18next";
import type { LiveKitInstanceAdmin } from "../../types";

type InstanceFormProps = {
  mode: "create" | "edit";
  instance?: LiveKitInstanceAdmin | null;
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
  onCancel?: () => void;
  onDelete?: () => void;
  migrateTargetId?: string;
  setMigrateTargetId?: (v: string) => void;
  otherInstances?: LiveKitInstanceAdmin[];
};

function InstanceForm({
  mode,
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
  onCancel,
  onDelete,
  migrateTargetId,
  setMigrateTargetId,
  otherInstances,
}: InstanceFormProps) {
  const { t } = useTranslation("settings");
  const isCreate = mode === "create";

  const canSave = isCreate
    ? !!(formUrl && formApiKey && formApiSecret)
    : instance
      ? formUrl !== instance.url ||
        formApiKey !== "" ||
        formApiSecret !== "" ||
        formMaxServers !== instance.max_servers ||
        formHetznerServerID !== (instance.hetzner_server_id ?? "")
      : false;

  return (
    <div className="channel-perm-section">
      <h2 className="settings-section-title channel-settings-right-title">
        {isCreate ? t("platformAddInstance") : t("platformEditInstance")}
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
        {!isCreate && (
          <span className="settings-hint">{t("platformCredentialsHint")}</span>
        )}
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

      {/* Server count — edit mode only */}
      {!isCreate && instance && (
        <div className="settings-field">
          <label className="settings-label">
            {t("platformInstanceServerCount")}
          </label>
          <span className="settings-value">{instance.server_count}</span>
        </div>
      )}

      <div className="settings-btn-row">
        <button
          className="settings-btn"
          disabled={!canSave || isSaving}
          onClick={onSave}
        >
          {isSaving
            ? t("saving")
            : isCreate
              ? t("platformAddInstance")
              : t("save")}
        </button>
        {isCreate && onCancel && (
          <button className="settings-btn settings-btn-secondary" onClick={onCancel}>
            {t("cancel")}
          </button>
        )}
      </div>

      {/* Danger Zone — edit mode only */}
      {!isCreate && instance && onDelete && (
        <>
          <div className="dz-separator" />
          <div className="dz-section">
            <h2 className="dz-title">{t("dangerZone")}</h2>

            <div className="dz-card">
              <h3 className="dz-card-title">{t("platformDeleteInstance")}</h3>
              <p className="dz-card-desc">{t("platformDeleteDesc")}</p>

              {instance.server_count > 0 && setMigrateTargetId && (
                <div className="settings-field">
                  <label className="settings-label">{t("platformMigrateTarget")}</label>
                  <select
                    className="settings-select"
                    value={migrateTargetId ?? ""}
                    onChange={(e) => setMigrateTargetId(e.target.value)}
                  >
                    <option value="">{t("platformSelectTarget")}</option>
                    {otherInstances?.map((other) => (
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
        </>
      )}
    </div>
  );
}

export default InstanceForm;

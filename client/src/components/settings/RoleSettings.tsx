/**
 * RoleSettings — Rol yönetimi Settings paneli.
 *
 * CSS class'ları: .role-list, .role-list-item, .role-list-item.active,
 * .role-list-dot, .role-list-name, .settings-label, .settings-input,
 * .settings-btn, .settings-btn-danger, .permission-toggle-*
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRoleStore } from "../../stores/roleStore";
import { useToastStore } from "../../stores/toastStore";
import { Permissions } from "../../utils/permissions";
import PermissionToggle from "./PermissionToggle";
import ColorPicker from "./ColorPicker";

const PERMISSION_DEFS = [
  {
    bit: Permissions.Admin,
    label: "permAdmin",
    desc: "permAdminDesc",
    warning: "permAdminWarning",
  },
  { bit: Permissions.ManageChannels, label: "permManageChannels", desc: "permManageChannelsDesc" },
  { bit: Permissions.ManageRoles, label: "permManageRoles", desc: "permManageRolesDesc" },
  { bit: Permissions.KickMembers, label: "permKickMembers", desc: "permKickMembersDesc" },
  { bit: Permissions.BanMembers, label: "permBanMembers", desc: "permBanMembersDesc" },
  { bit: Permissions.ManageMessages, label: "permManageMessages", desc: "permManageMessagesDesc" },
  { bit: Permissions.SendMessages, label: "permSendMessages", desc: "permSendMessagesDesc" },
  { bit: Permissions.ReadMessages, label: "permReadMessages", desc: "permReadMessagesDesc" },
  { bit: Permissions.Connect, label: "permConnect", desc: "permConnectDesc" },
  { bit: Permissions.Speak, label: "permSpeak", desc: "permSpeakDesc" },
] as const;

function RoleSettings() {
  const { t } = useTranslation("settings");
  const {
    roles,
    selectedRoleId,
    isLoading,
    fetchRoles,
    selectRole,
    createRole,
    updateRole,
    deleteRole,
  } = useRoleStore();
  const addToast = useToastStore((s) => s.addToast);

  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editPerms, setEditPerms] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  useEffect(() => {
    if (selectedRole) {
      setEditName(selectedRole.name);
      setEditColor(selectedRole.color);
      setEditPerms(selectedRole.permissions);
      setHasChanges(false);
    }
  }, [selectedRole]);

  function handlePermToggle(bit: number, checked: boolean) {
    setEditPerms((prev) => (checked ? prev | bit : prev & ~bit));
    setHasChanges(true);
  }

  async function handleSave() {
    if (!selectedRoleId || !hasChanges) return;

    const updates: { name?: string; color?: string; permissions?: number } = {};
    if (editName !== selectedRole?.name) updates.name = editName;
    if (editColor !== selectedRole?.color) updates.color = editColor;
    if (editPerms !== selectedRole?.permissions) updates.permissions = editPerms;

    const success = await updateRole(selectedRoleId, updates);
    if (success) {
      setHasChanges(false);
      addToast("success", t("roleSaved"));
    } else {
      addToast("error", t("roleSaveError"));
    }
  }

  async function handleCreate() {
    const success = await createRole({
      name: "New Role",
      color: "#99AAB5",
      permissions: Permissions.SendMessages | Permissions.ReadMessages,
    });
    if (success) {
      addToast("success", t("roleCreated"));
    } else {
      addToast("error", t("roleSaveError"));
    }
  }

  async function handleDelete() {
    if (!selectedRole) return;
    if (!confirm(t("confirmDeleteRole", { name: selectedRole.name }))) return;
    const success = await deleteRole(selectedRole.id);
    if (success) {
      addToast("success", t("roleDeleted"));
    } else {
      addToast("error", t("roleSaveError"));
    }
  }

  if (isLoading) {
    return (
      <div className="no-channel">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Sol Panel: Rol Listesi */}
      <div className="role-list">
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 8px" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t0)" }}>
            {t("roles")}
          </span>
          <button onClick={handleCreate} className="settings-btn" style={{ height: 28, padding: "0 10px", fontSize: 11 }}>
            {t("createRole")}
          </button>
        </div>

        {/* Rol listesi */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 4px" }}>
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => selectRole(role.id)}
              className={`role-list-item${role.id === selectedRoleId ? " active" : ""}`}
            >
              <span
                className="role-list-dot"
                style={{ backgroundColor: role.color || "#99AAB5" }}
              />
              <span className="role-list-name">{role.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Sağ Panel: Rol Editörü */}
      <div className="settings-content" style={{ padding: 24 }}>
        {selectedRole ? (
          <div style={{ maxWidth: 560 }}>
            {/* Rol adı */}
            <div className="settings-field">
              <label className="settings-label">{t("roleName")}</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  setHasChanges(true);
                }}
                className="settings-input"
              />
            </div>

            {/* Rol rengi */}
            <div className="settings-field">
              <label className="settings-label">{t("roleColor")}</label>
              <ColorPicker
                value={editColor}
                onChange={(color) => {
                  setEditColor(color);
                  setHasChanges(true);
                }}
              />
            </div>

            {/* Default rol uyarısı */}
            {selectedRole.is_default && (
              <div style={{ background: "var(--bg-4)", borderRadius: 8, padding: 12, fontSize: 12, color: "var(--t2)", marginBottom: 16 }}>
                {t("defaultRoleWarning")}
              </div>
            )}

            {/* Yetkiler */}
            <div className="settings-field">
              <label className="settings-label">{t("permissions")}</label>
              <div style={{ background: "var(--bg-1)", borderRadius: 8, overflow: "hidden" }}>
                {PERMISSION_DEFS.map((perm) => (
                  <PermissionToggle
                    key={perm.bit}
                    permBit={perm.bit}
                    labelKey={perm.label}
                    descKey={perm.desc}
                    isChecked={(editPerms & perm.bit) !== 0}
                    onChange={handlePermToggle}
                    warningKey={"warning" in perm ? perm.warning : undefined}
                  />
                ))}
              </div>
            </div>

            {/* Aksiyon butonları */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {hasChanges && (
                <button onClick={handleSave} className="settings-btn">
                  {t("saveChanges")}
                </button>
              )}
              {!selectedRole.is_default && (
                <button onClick={handleDelete} className="settings-btn settings-btn-danger">
                  {t("deleteRole")}
                </button>
              )}
            </div>

            {hasChanges && (
              <p style={{ marginTop: 8, fontSize: 12, color: "var(--amber)" }}>{t("unsavedChanges")}</p>
            )}
          </div>
        ) : (
          <div className="no-channel">
            {t("noRoleSelected")}
          </div>
        )}
      </div>
    </div>
  );
}

export default RoleSettings;

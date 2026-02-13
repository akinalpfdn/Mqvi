/**
 * RoleSettings — Rol yönetimi Settings paneli.
 *
 * İki bölüm:
 * - Sol: Rol listesi (position DESC), "Create Role" butonu
 * - Sağ: Seçili rolün düzenleyicisi (isim, renk, permission toggle'ları)
 *
 * Discord referans: Server Settings → Roles
 *
 * Settings modal'ında "Roles" tab'ı olarak gösterilir.
 * CRUD operasyonlarında toast feedback verir (başarı/hata bildirimi).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRoleStore } from "../../stores/roleStore";
import { useToastStore } from "../../stores/toastStore";
import { Permissions } from "../../utils/permissions";
import PermissionToggle from "./PermissionToggle";
import ColorPicker from "./ColorPicker";

/** Permission tanımları — her toggle için bit, label key, desc key ve opsiyonel warning */
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

  // Düzenleme formu state'i — seçili rol değiştiğinde sıfırlanır
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editPerms, setEditPerms] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);

  // Component mount'ta rolleri fetch et
  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  // Seçili rol değiştiğinde form state'ini güncelle
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
      <div className="flex h-full items-center justify-center text-text-muted">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* ─── Sol Panel: Rol Listesi ─── */}
      <div className="flex w-56 shrink-0 flex-col border-r border-background-tertiary bg-background-secondary">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="text-sm font-semibold text-text-primary">
            {t("roles")}
          </h3>
          <button
            onClick={handleCreate}
            className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
          >
            {t("createRole")}
          </button>
        </div>

        {/* Rol listesi */}
        <div className="flex-1 overflow-y-auto px-2">
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => selectRole(role.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors ${
                role.id === selectedRoleId
                  ? "bg-surface-active text-text-primary"
                  : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              }`}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: role.color || "#99AAB5" }}
              />
              <span className="truncate text-sm">{role.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ─── Sağ Panel: Rol Editörü ─── */}
      <div className="flex-1 overflow-y-auto bg-background p-6">
        {selectedRole ? (
          <div className="mx-auto max-w-xl">
            {/* Rol adı */}
            <div className="mb-6">
              <label className="mb-2 block text-xs font-bold uppercase text-text-muted">
                {t("roleName")}
              </label>
              <input
                type="text"
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  setHasChanges(true);
                }}
                className="h-10 w-full rounded-md bg-input px-3 text-sm text-text-primary outline-none transition-colors focus:bg-input-focus"
              />
            </div>

            {/* Rol rengi */}
            <div className="mb-6">
              <label className="mb-2 block text-xs font-bold uppercase text-text-muted">
                {t("roleColor")}
              </label>
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
              <div className="mb-4 rounded-md bg-background-tertiary p-3 text-xs text-text-muted">
                {t("defaultRoleWarning")}
              </div>
            )}

            {/* Yetkiler */}
            <div className="mb-6">
              <label className="mb-2 block text-xs font-bold uppercase text-text-muted">
                {t("permissions")}
              </label>
              <div className="divide-y divide-background-tertiary rounded-md bg-background-secondary">
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
            <div className="flex items-center gap-3">
              {/* Save butonu */}
              {hasChanges && (
                <button
                  onClick={handleSave}
                  className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
                >
                  {t("saveChanges")}
                </button>
              )}

              {/* Delete butonu (default rol silinemez) */}
              {!selectedRole.is_default && (
                <button
                  onClick={handleDelete}
                  className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-80"
                >
                  {t("deleteRole")}
                </button>
              )}
            </div>

            {/* Unsaved changes bilgisi */}
            {hasChanges && (
              <p className="mt-2 text-xs text-warning">{t("unsavedChanges")}</p>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-text-muted">
            {t("noRoleSelected")}
          </div>
        )}
      </div>
    </div>
  );
}

export default RoleSettings;

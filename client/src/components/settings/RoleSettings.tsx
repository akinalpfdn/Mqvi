/**
 * RoleSettings — Rol yönetimi Settings paneli.
 *
 * Özellikler:
 * - Drag & drop ile rol sıralaması (HTML5 DnD API — ChannelTree pattern)
 * - Hiyerarşi kısıtlaması: sadece kendi en yüksek rolünden düşük rolleri düzenle/sırala
 * - Default rol (Member) her zaman altta sabit, sürüklenemez
 *
 * CSS class'ları: .role-list, .role-list-item, .role-list-item.active,
 * .role-list-dot, .role-list-name, .role-drag-wrap, .role-drag-handle,
 * .settings-label, .settings-input, .settings-btn, .settings-btn-danger,
 * .permission-toggle-*
 */

import { useEffect, useState, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useRoleStore } from "../../stores/roleStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
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
  { bit: Permissions.ViewChannel, label: "permViewChannel", desc: "permViewChannelDesc" },
  { bit: Permissions.ConnectVoice, label: "permConnect", desc: "permConnectDesc" },
  { bit: Permissions.Speak, label: "permSpeak", desc: "permSpeakDesc" },
  { bit: Permissions.Stream, label: "permStream", desc: "permStreamDesc" },
  { bit: Permissions.MoveMembers, label: "permMoveMembers", desc: "permMoveMembersDesc" },
  { bit: Permissions.MuteMembers, label: "permMuteMembers", desc: "permMuteMembersDesc" },
  { bit: Permissions.DeafenMembers, label: "permDeafenMembers", desc: "permDeafenMembersDesc" },
  { bit: Permissions.ManageInvites, label: "permManageInvites", desc: "permManageInvitesDesc" },
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
    reorderRoles,
  } = useRoleStore();
  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // ─── Actor hiyerarşi hesabı ───
  // MembersSettings.tsx:62-67 pattern'i ile aynı.
  // Actor'un effective_permissions ve en yüksek rol position'ını hesapla.
  const myPerms = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return me?.effective_permissions ?? 0;
  }, [members, currentUser]);

  const actorMaxPos = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    if (!me || me.roles.length === 0) return 0;
    return Math.max(...me.roles.map((r) => r.position));
  }, [members, currentUser]);

  const canManageRoles = hasPermission(myPerms, Permissions.ManageRoles);

  // ─── Edit state ───
  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editPerms, setEditPerms] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);

  const isOwnerRole = selectedRole?.id === "owner";

  // Actor server owner mı? (owner rolüne sahip mi)
  const isActorOwner = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return me?.roles.some((r) => r.id === "owner") ?? false;
  }, [members, currentUser]);

  // Seçili rol actor'dan yüksek veya eşit mi?
  // Eğer öyleyse düzenleme disabled olmalı.
  const isRoleAboveActor = selectedRole
    ? selectedRole.position >= actorMaxPos
    : false;

  // Owner rolü → sadece server owner isim + renk düzenleyebilir
  // Diğer roller → canManageRoles + hiyerarşi kontrolü
  const canEditSelected = canManageRoles && !isRoleAboveActor && !isOwnerRole;
  const canEditOwnerAppearance = isOwnerRole && isActorOwner;

  // ─── Drag & Drop state ───
  // HTML5 DnD API — ChannelTree.tsx pattern ile aynı.
  const dragRoleIdRef = useRef<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    roleId: string;
    position: "above" | "below";
  } | null>(null);

  /** Bir rolün sürüklenebilir olup olmadığını belirle */
  function isDraggable(role: { id: string; is_default: boolean; position: number }): boolean {
    if (role.id === "owner") return false; // Owner rolü her zaman en üstte sabit
    if (role.is_default) return false;
    if (role.position >= actorMaxPos) return false;
    return canManageRoles;
  }

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

  // ─── Drag & Drop Handlers ───

  function handleDragStart(roleId: string) {
    dragRoleIdRef.current = roleId;
  }

  function handleDragOver(e: React.DragEvent, roleId: string) {
    const role = roles.find((r) => r.id === roleId);
    // Drop hedefi sürüklenebilir olmalı (default veya üst rol üzerine drop yok)
    if (!role || !isDraggable(role)) return;
    // Kendi üzerine sürükleme ihmal
    if (dragRoleIdRef.current === roleId) {
      e.preventDefault();
      setDropIndicator(null);
      return;
    }
    e.preventDefault();

    // Mouse'un hedef elemanın üst yarısında mı alt yarısında mı olduğunu hesapla
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const pos: "above" | "below" = e.clientY < midY ? "above" : "below";
    setDropIndicator({ roleId, position: pos });
  }

  function handleDragLeave() {
    setDropIndicator(null);
  }

  function handleDrop(e: React.DragEvent, targetRoleId: string) {
    e.preventDefault();
    setDropIndicator(null);

    const dragId = dragRoleIdRef.current;
    dragRoleIdRef.current = null;

    if (!dragId || dragId === targetRoleId) return;

    // Sadece manageable rolleri filtrele (owner, default ve üst roller hariç)
    const manageable = roles.filter(
      (r) => r.id !== "owner" && !r.is_default && r.position < actorMaxPos
    );

    const ordered = [...manageable];
    const dragIdx = ordered.findIndex((r) => r.id === dragId);
    const targetIdx = ordered.findIndex((r) => r.id === targetRoleId);
    if (dragIdx === -1 || targetIdx === -1) return;

    // Sürüklenen rolü listeden çıkar
    const [dragged] = ordered.splice(dragIdx, 1);

    // Hedefin yeni index'ini hesapla (splice sonrası index kayması)
    let insertIdx = ordered.findIndex((r) => r.id === targetRoleId);
    if (insertIdx === -1) insertIdx = ordered.length;

    // Mouse pozisyonuna göre üstte veya altta ekle
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    // Position atama:
    // Liste üstten alta sıralı (ordered[0] = en yüksek rank).
    // Position 1 default role ayrılmış. Manageable roller 2'den başlar.
    // ordered[0] → en yüksek position, ordered[N-1] → en düşük position.
    const items = ordered.map((role, idx) => ({
      id: role.id,
      position: 2 + (ordered.length - 1 - idx),
    }));

    reorderRoles(items).then((ok) => {
      if (!ok) addToast("error", t("roleReorderError"));
    });
  }

  function handleDragEnd() {
    dragRoleIdRef.current = null;
    setDropIndicator(null);
  }

  // ─── CRUD Handlers ───

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
      permissions: Permissions.SendMessages | Permissions.ReadMessages | Permissions.ConnectVoice | Permissions.Speak,
    });
    if (success) {
      addToast("success", t("roleCreated"));
    } else {
      addToast("error", t("roleSaveError"));
    }
  }

  async function handleDelete() {
    if (!selectedRole) return;
    const ok = await confirm({
      message: t("confirmDeleteRole", { name: selectedRole.name }),
      confirmLabel: t("deleteRole"),
      danger: true,
    });
    if (!ok) return;
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
    <div className="channel-settings-wrapper">
      {/* Sol Panel: Rol Listesi */}
      <div className="role-list">
        {/* Header */}
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {t("roles")}
          </span>
          {canManageRoles && (
            <button onClick={handleCreate} className="settings-btn channel-settings-header-btn">
              {t("createRole")}
            </button>
          )}
        </div>

        {/* Rol listesi — drag & drop destekli */}
        <div className="channel-settings-ch-list">
          {roles.map((role) => {
            const draggable = isDraggable(role);
            const indicator = dropIndicator?.roleId === role.id ? dropIndicator : null;
            const dropPos = indicator?.position ?? null;

            return (
              <div
                key={role.id}
                className={`role-drag-wrap${dragRoleIdRef.current === role.id ? " dragging" : ""}${dropPos === "above" ? " drop-above" : ""}${dropPos === "below" ? " drop-below" : ""}`}
                draggable={draggable}
                onDragStart={() => handleDragStart(role.id)}
                onDragOver={(e) => handleDragOver(e, role.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, role.id)}
                onDragEnd={handleDragEnd}
              >
                <div
                  onClick={() => selectRole(role.id)}
                  className={`role-list-item${role.id === selectedRoleId ? " active" : ""}`}
                >
                  {draggable && (
                    <span className="role-drag-handle">&#x2630;</span>
                  )}
                  <span
                    className="role-list-dot"
                    style={{ backgroundColor: role.color || "#99AAB5" }}
                  />
                  <span className="role-list-name">{role.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sag Panel: Rol Editoru */}
      <div className="settings-content channel-settings-right">
        {selectedRole ? (
          <div className="channel-perm-section">
            {/* Owner rolü uyarısı */}
            {isOwnerRole && !isActorOwner && (
              <div className="role-hierarchy-warning">
                {t("ownerRoleWarning")}
              </div>
            )}
            {isOwnerRole && isActorOwner && (
              <div className="role-hierarchy-warning">
                {t("ownerRoleEditHint")}
              </div>
            )}

            {/* Hiyerarsi uyarisi — actor'dan yuksek/esit rol secilmisse */}
            {!isOwnerRole && isRoleAboveActor && (
              <div className="role-hierarchy-warning">
                {t("roleCannotEdit")}
              </div>
            )}

            {/* Rol adi */}
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
                disabled={!(canEditSelected || canEditOwnerAppearance)}
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
                disabled={!(canEditSelected || canEditOwnerAppearance)}
              />
            </div>

            {/* Aksiyon butonlari — yetkiler ile renk arasinda */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={handleSave}
                className="settings-btn"
                disabled={!hasChanges || !(canEditSelected || canEditOwnerAppearance)}
              >
                {t("saveChanges")}
              </button>
              {!selectedRole.is_default && !isOwnerRole && canEditSelected && (
                <button onClick={handleDelete} className="settings-btn settings-btn-danger">
                  {t("deleteRole")}
                </button>
              )}
            </div>

            {/* Default rol uyarisi */}
            {selectedRole.is_default && (
              <div style={{ background: "var(--bg-4)", borderRadius: 8, padding: 12, fontSize: 13, color: "var(--t2)", marginBottom: 16 }}>
                {t("defaultRoleWarning")}
              </div>
            )}

            {/* Yetkiler */}
            <div className="settings-field">
              <label className="settings-label">{t("permissions")}</label>
              <div style={{ background: "var(--bg-1)", borderRadius: 8, overflow: "hidden" }}>
                {PERMISSION_DEFS.map((perm) => {
                  // Admin yetkisi verme: sadece Admin yetkisine sahip olanlar yapabilir.
                  // ManageRoles yetkisi olan ama Admin olmayan biri, bir role Admin
                  // atayıp kendine vererek privilege escalation yapabilir — bunu engelliyoruz.
                  const isAdminPerm = perm.bit === Permissions.Admin;
                  const actorHasAdmin = hasPermission(myPerms, Permissions.Admin);
                  const permDisabled = !canEditSelected || (isAdminPerm && !actorHasAdmin);

                  return (
                  <PermissionToggle
                    key={perm.bit}
                    permBit={perm.bit}
                    labelKey={perm.label}
                    descKey={perm.desc}
                    isChecked={(editPerms & perm.bit) !== 0}
                    onChange={handlePermToggle}
                    warningKey={"warning" in perm ? perm.warning : undefined}
                    disabled={permDisabled}
                  />
                  );
                })}
              </div>
            </div>
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

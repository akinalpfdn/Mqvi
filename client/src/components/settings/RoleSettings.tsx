/** RoleSettings — Role management panel with drag-and-drop reordering and hierarchy enforcement. */

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
import EmojiPicker from "../shared/EmojiPicker";

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
  { bit: Permissions.UseSoundboard, label: "permUseSoundboard", desc: "permUseSoundboardDesc" },
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

  const selectedRole = roles.find((r) => r.id === selectedRoleId);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editPerms, setEditPerms] = useState(0);
  const [editMentionable, setEditMentionable] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [showRoleEmojiPicker, setShowRoleEmojiPicker] = useState(false);

  const isOwnerRole = selectedRole?.is_owner ?? false;

  const isActorOwner = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return me?.roles.some((r) => r.is_owner) ?? false;
  }, [members, currentUser]);

  const isRoleAboveActor = selectedRole
    ? selectedRole.position >= actorMaxPos
    : false;

  // Owner role: only server owner can edit name + color
  const canEditSelected = canManageRoles && !isRoleAboveActor && !isOwnerRole;
  const canEditOwnerAppearance = isOwnerRole && isActorOwner;

  const dragRoleIdRef = useRef<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    roleId: string;
    position: "above" | "below";
  } | null>(null);

  function isDraggable(role: { id: string; is_default: boolean; is_owner: boolean; position: number }): boolean {
    if (role.is_owner) return false;
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
      setEditMentionable(selectedRole.mentionable);
      setHasChanges(false);
    }
  }, [selectedRole]);

  function handleDragStart(roleId: string) {
    dragRoleIdRef.current = roleId;
  }

  function handleDragOver(e: React.DragEvent, roleId: string) {
    const role = roles.find((r) => r.id === roleId);
    if (!role || !isDraggable(role)) return;
    if (dragRoleIdRef.current === roleId) {
      e.preventDefault();
      setDropIndicator(null);
      return;
    }
    e.preventDefault();

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

    // Exclude owner, default, and roles above actor
    const manageable = roles.filter(
      (r) => r.id !== "owner" && !r.is_default && r.position < actorMaxPos
    );

    const ordered = [...manageable];
    const dragIdx = ordered.findIndex((r) => r.id === dragId);
    const targetIdx = ordered.findIndex((r) => r.id === targetRoleId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [dragged] = ordered.splice(dragIdx, 1);

    let insertIdx = ordered.findIndex((r) => r.id === targetRoleId);
    if (insertIdx === -1) insertIdx = ordered.length;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY >= midY) insertIdx += 1;

    ordered.splice(insertIdx, 0, dragged);

    // Position 1 reserved for default role; manageable roles start at 2
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

  function handlePermToggle(bit: number, checked: boolean) {
    setEditPerms((prev) => (checked ? prev | bit : prev & ~bit));
    setHasChanges(true);
  }

  async function handleSave() {
    if (!selectedRoleId || !hasChanges) return;

    const updates: { name?: string; color?: string; permissions?: number; mentionable?: boolean } = {};
    if (editName !== selectedRole?.name) updates.name = editName;
    if (editColor !== selectedRole?.color) updates.color = editColor;
    if (editPerms !== selectedRole?.permissions) updates.permissions = editPerms;
    if (editMentionable !== selectedRole?.mentionable) updates.mentionable = editMentionable;

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
      {/* Left Panel: Role List */}
      <div className="role-list">
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

      {/* Right Panel: Role Editor */}
      <div className="settings-content channel-settings-right">
        {selectedRole ? (
          <div className="channel-perm-section">
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

            {!isOwnerRole && isRoleAboveActor && (
              <div className="role-hierarchy-warning">
                {t("roleCannotEdit")}
              </div>
            )}

            <div className="settings-field">
              <label className="settings-label">{t("roleName")}</label>
              <div className="name-input-with-emoji">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setHasChanges(true);
                  }}
                  className="settings-input"
                  maxLength={50}
                  disabled={!(canEditSelected || canEditOwnerAppearance)}
                />
                {(canEditSelected || canEditOwnerAppearance) && (
                  <>
                    <button
                      type="button"
                      className="name-emoji-btn"
                      onClick={() => setShowRoleEmojiPicker((p) => !p)}
                      title={t("emoji", { ns: "chat" })}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </button>
                    {showRoleEmojiPicker && (
                      <div className="name-emoji-picker-wrap">
                        <EmojiPicker
                          onSelect={(emoji) => {
                            setEditName((prev) => {
                              const next = prev + emoji;
                              if ([...next].length > 50) return prev;
                              return next;
                            });
                            setHasChanges(true);
                            setShowRoleEmojiPicker(false);
                          }}
                          onClose={() => setShowRoleEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

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

            {/* Mentionable toggle */}
            <div className="settings-field">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <label className="settings-label" style={{ marginBottom: 0 }}>{t("roleMentionable")}</label>
                  <p style={{ fontSize: 13, color: "var(--t3)", margin: "4px 0 0" }}>{t("roleMentionableDesc")}</p>
                </div>
                <button
                  type="button"
                  className={`toggle-switch${editMentionable ? " toggle-switch-on" : ""}`}
                  onClick={() => {
                    setEditMentionable((prev) => !prev);
                    setHasChanges(true);
                  }}
                  disabled={!(canEditSelected || canEditOwnerAppearance)}
                >
                  <span className="toggle-switch-thumb" />
                </button>
              </div>
            </div>

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

            {selectedRole.is_default && (
              <div style={{ background: "var(--bg-4)", borderRadius: 8, padding: 12, fontSize: 13, color: "var(--t2)", marginBottom: 16 }}>
                {t("defaultRoleWarning")}
              </div>
            )}

            <div className="settings-field">
              <label className="settings-label">{t("permissions")}</label>
              <div style={{ background: "var(--bg-1)", borderRadius: 8, overflow: "hidden" }}>
                {PERMISSION_DEFS.map((perm) => {
                  // Prevent privilege escalation: only admins can grant Admin
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

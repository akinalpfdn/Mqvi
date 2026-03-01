/**
 * MembersSettings — Üye yönetimi Settings paneli.
 *
 * İki sekme:
 * - "Members": Tüm üyeler + rol atama + kick/ban
 * - "Bans": Banlı üyeler + unban (sadece BAN_MEMBERS yetkisi varsa görünür)
 *
 * CSS class'ları: channel-settings-wrapper, channel-settings-header,
 * channel-settings-ch-list, role-list-item, settings-btn, settings-btn-danger,
 * member-settings-tabs, member-settings-tab
 *
 * Yetki gereksinimleri:
 * - Rol atama: MANAGE_ROLES (hiyerarşi kontrolü backend'de)
 * - Kick: KICK_MEMBERS
 * - Ban/Unban: BAN_MEMBERS
 */

import { useEffect, useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";
import { resolveAssetUrl } from "../../utils/constants";
import type { Ban } from "../../types";

type Tab = "members" | "bans";

function MembersSettings() {
  const { t } = useTranslation("settings");
  const members = useMemberStore((s) => s.members);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const roles = useRoleStore((s) => s.roles);
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const currentUser = useAuthStore((s) => s.user);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // ─── Tab state ───
  const [activeTab, setActiveTab] = useState<Tab>("members");

  // ─── Members state ───
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  // ─── Bans state ───
  const [bans, setBans] = useState<Ban[]>([]);
  const [isBansLoading, setIsBansLoading] = useState(false);
  const [selectedBanUserId, setSelectedBanUserId] = useState<string | null>(null);

  useEffect(() => {
    fetchMembers();
    fetchRoles();
  }, [fetchMembers, fetchRoles]);

  const selectedMember = members.find((m) => m.id === selectedMemberId);

  /** Seçili üye değiştiğinde editRoleIds'i senkronize et */
  useEffect(() => {
    if (selectedMember) {
      setEditRoleIds(selectedMember.roles.map((r) => r.id));
      setHasChanges(false);
    }
  }, [selectedMember]);

  /** Mevcut kullanıcının effective permissions'ı */
  const myPerms = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return me?.effective_permissions ?? 0;
  }, [members, currentUser]);

  /** Actor'un en yüksek rol position'ı — hiyerarşi kontrolü için */
  const actorMaxPos = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    if (!me || me.roles.length === 0) return 0;
    return Math.max(...me.roles.map((r) => r.position));
  }, [members, currentUser]);

  const canManageRoles = hasPermission(myPerms, Permissions.ManageRoles);
  const canKick = hasPermission(myPerms, Permissions.KickMembers);
  const canBan = hasPermission(myPerms, Permissions.BanMembers);

  /** Seçili üyenin en yüksek rol position'ı */
  const targetMaxPos = useMemo(() => {
    if (!selectedMember || selectedMember.roles.length === 0) return 0;
    return Math.max(...selectedMember.roles.map((r) => r.position));
  }, [selectedMember]);

  /** Seçili üye owner rolüne sahip mi? */
  const isTargetOwner = selectedMember?.roles.some((r) => r.id === "owner") ?? false;

  const canActOnTarget = !isTargetOwner && targetMaxPos < actorMaxPos;

  /** Üyenin en yüksek rol rengi — avatar border ve isim rengi için */
  function getMemberColor(member: typeof members[0]): string {
    if (member.roles.length === 0) return "var(--color-text-secondary)";
    const sorted = [...member.roles].sort((a, b) => b.position - a.position);
    return sorted[0].color || "var(--color-text-secondary)";
  }

  // ─── Bans fetch ───
  const fetchBans = useCallback(async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    setIsBansLoading(true);
    const res = await memberApi.getBans(serverId);
    if (res.data) {
      setBans(res.data);
    }
    setIsBansLoading(false);
  }, []);

  /** Tab değiştiğinde bans'ı fetch et */
  useEffect(() => {
    if (activeTab === "bans" && canBan) {
      fetchBans();
    }
  }, [activeTab, canBan, fetchBans]);

  /** Tab geçişinde seçimi temizle */
  function handleTabChange(tab: Tab) {
    setActiveTab(tab);
    setSelectedMemberId(null);
    setSelectedBanUserId(null);
    setHasChanges(false);
  }

  const selectedBan = bans.find((b) => b.user_id === selectedBanUserId);

  // ─── Member Handlers ───

  function handleRoleToggle(roleId: string) {
    setEditRoleIds((prev) => {
      const next = prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId];
      return next;
    });
    setHasChanges(true);
  }

  async function handleSaveRoles() {
    if (!selectedMemberId || !hasChanges) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.modifyMemberRoles(serverId, selectedMemberId, editRoleIds);
    if (res.data) {
      setHasChanges(false);
      addToast("success", t("memberRolesSaved"));
    } else {
      addToast("error", res.error ?? t("memberRolesSaveError"));
    }
  }

  async function handleKick() {
    if (!selectedMember) return;
    const displayName = selectedMember.display_name || selectedMember.username;
    const ok = await confirm({
      message: t("confirmKick", { name: displayName }),
      confirmLabel: t("kickMember"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.kickMember(serverId, selectedMember.id);
    if (res.data) {
      addToast("success", t("memberKicked"));
      setSelectedMemberId(null);
    } else {
      addToast("error", res.error ?? t("memberKickError"));
    }
  }

  async function handleBan() {
    if (!selectedMember) return;
    const displayName = selectedMember.display_name || selectedMember.username;
    const ok = await confirm({
      message: t("confirmBan", { name: displayName }),
      confirmLabel: t("banMember"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.banMember(serverId, selectedMember.id, "Banned by admin");
    if (res.data) {
      addToast("success", t("memberBanned"));
      setSelectedMemberId(null);
    } else {
      addToast("error", res.error ?? t("memberBanError"));
    }
  }

  // ─── Unban Handler ───
  async function handleUnban() {
    if (!selectedBan) return;
    const ok = await confirm({
      message: t("confirmUnban", { name: selectedBan.username }),
      confirmLabel: t("unban"),
      danger: false,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.unbanMember(serverId, selectedBan.user_id);
    if (res.data) {
      addToast("success", t("memberUnbanned"));
      setBans((prev) => prev.filter((b) => b.user_id !== selectedBan.user_id));
      setSelectedBanUserId(null);
    } else {
      addToast("error", res.error ?? t("memberUnbanError"));
    }
  }

  /** Kendimiz mi? Kendimize kick/ban yapamayız */
  const isSelf = selectedMemberId === currentUser?.id;

  /** Ban tarihini okunabilir formata çevir */
  function formatBanDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="channel-settings-wrapper">
      {/* Sol Panel */}
      <div className="role-list">
        {/* Tab Toggle — sadece BAN_MEMBERS yetkisi varsa göster */}
        {canBan ? (
          <div className="member-settings-tabs">
            <button
              onClick={() => handleTabChange("members")}
              className={`member-settings-tab${activeTab === "members" ? " active" : ""}`}
            >
              {t("members")} ({members.length})
            </button>
            <button
              onClick={() => handleTabChange("bans")}
              className={`member-settings-tab${activeTab === "bans" ? " active" : ""}`}
            >
              {t("bannedMembers")} ({bans.length})
            </button>
          </div>
        ) : (
          <div className="channel-settings-header">
            <span className="channel-settings-header-label">
              {t("members")} ({members.length})
            </span>
          </div>
        )}

        {/* Members List */}
        {activeTab === "members" && (
          <div className="channel-settings-ch-list">
            {members.map((member) => (
              <div
                key={member.id}
                onClick={() => setSelectedMemberId(member.id)}
                className={`role-list-item${member.id === selectedMemberId ? " active" : ""}`}
              >
                {/* Avatar */}
                <div
                  className="member-settings-avatar"
                  style={{
                    borderColor: getMemberColor(member),
                  }}
                >
                  {member.avatar_url ? (
                    <img
                      src={resolveAssetUrl(member.avatar_url)}
                      alt={member.username}
                      className="member-settings-avatar-img"
                    />
                  ) : (
                    <span className="member-settings-avatar-fallback">
                      {(member.display_name || member.username).charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>

                {/* İsim + username */}
                <div className="member-settings-info">
                  <span
                    className="member-settings-name"
                    style={{ color: getMemberColor(member) }}
                  >
                    {member.display_name || member.username}
                  </span>
                  <span className="member-settings-username">
                    {member.username}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Bans List */}
        {activeTab === "bans" && (
          <div className="channel-settings-ch-list">
            {isBansLoading ? (
              <div className="no-channel">
                {t("loading", { ns: "common" })}
              </div>
            ) : bans.length === 0 ? (
              <div className="no-channel">
                {t("noBannedMembers")}
              </div>
            ) : (
              bans.map((ban) => (
                <div
                  key={ban.user_id}
                  onClick={() => setSelectedBanUserId(ban.user_id)}
                  className={`role-list-item${ban.user_id === selectedBanUserId ? " active" : ""}`}
                >
                  {/* Avatar fallback — banlı kullanıcının avatar'ı yok */}
                  <div className="member-settings-avatar member-settings-avatar-banned">
                    <span className="member-settings-avatar-fallback">
                      {ban.username.charAt(0).toUpperCase()}
                    </span>
                  </div>

                  <div className="member-settings-info">
                    <span className="member-settings-name member-settings-name-banned">
                      {ban.username}
                    </span>
                    <span className="member-settings-username">
                      {formatBanDate(ban.created_at)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Sağ Panel */}
      <div className="settings-content channel-settings-right">
        {/* ─── Members Tab — Right Panel ─── */}
        {activeTab === "members" && (
          <>
            {selectedMember ? (
              <div className="channel-perm-section">
                {/* Üye başlığı */}
                <div className="member-settings-detail-header">
                  <div
                    className="member-settings-avatar member-settings-avatar-lg"
                    style={{ borderColor: getMemberColor(selectedMember) }}
                  >
                    {selectedMember.avatar_url ? (
                      <img
                        src={resolveAssetUrl(selectedMember.avatar_url)}
                        alt={selectedMember.username}
                        className="member-settings-avatar-img"
                      />
                    ) : (
                      <span className="member-settings-avatar-fallback">
                        {(selectedMember.display_name || selectedMember.username).charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div>
                    <div
                      className="member-settings-detail-name"
                      style={{ color: getMemberColor(selectedMember) }}
                    >
                      {selectedMember.display_name || selectedMember.username}
                    </div>
                    <div className="member-settings-detail-username">
                      @{selectedMember.username}
                    </div>
                  </div>
                </div>

                {/* Mevcut roller */}
                <div className="settings-field">
                  <label className="settings-label">{t("memberCurrentRoles")}</label>
                  <div className="member-settings-role-tags">
                    {selectedMember.roles.length === 0 ? (
                      <span className="member-settings-no-roles">{t("memberNoRoles")}</span>
                    ) : (
                      selectedMember.roles.map((role) => (
                        <span
                          key={role.id}
                          className="member-settings-role-tag"
                          style={{ borderColor: role.color || "var(--color-text-muted)" }}
                        >
                          <span
                            className="role-list-dot"
                            style={{ backgroundColor: role.color || "#99AAB5" }}
                          />
                          {role.name}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                {/* Rol atama — ManageRoles yetkisi + hiyerarşi gerektirir */}
                {canManageRoles && canActOnTarget && !isSelf && (
                  <div className="settings-field">
                    <label className="settings-label">{t("memberAssignRoles")}</label>
                    <div className="member-settings-role-checkboxes">
                      {roles
                        .filter((role) => role.id !== "owner" && !role.is_default && role.position < actorMaxPos)
                        .map((role) => (
                        <label key={role.id} className="member-settings-role-checkbox">
                          <input
                            type="checkbox"
                            checked={editRoleIds.includes(role.id)}
                            onChange={() => handleRoleToggle(role.id)}
                          />
                          <span
                            className="role-list-dot"
                            style={{ backgroundColor: role.color || "#99AAB5" }}
                          />
                          <span>{role.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Kaydet butonu */}
                {canManageRoles && canActOnTarget && hasChanges && !isSelf && (
                  <div className="member-settings-actions">
                    <button onClick={handleSaveRoles} className="settings-btn">
                      {t("saveChanges")}
                    </button>
                    <p className="member-settings-unsaved">{t("unsavedChanges")}</p>
                  </div>
                )}

                {/* Kick / Ban — sadece başkalarına, yetki + hiyerarşi varsa */}
                {!isSelf && canActOnTarget && (canKick || canBan) && (
                  <div className="settings-field">
                    <label className="settings-label">{t("dangerZone")}</label>
                    <div className="member-settings-actions">
                      {canKick && (
                        <button
                          onClick={handleKick}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("kickMember")}
                        </button>
                      )}
                      {canBan && (
                        <button
                          onClick={handleBan}
                          className="settings-btn settings-btn-danger"
                        >
                          {t("banMember")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="no-channel">
                {t("noMemberSelected")}
              </div>
            )}
          </>
        )}

        {/* ─── Bans Tab — Right Panel ─── */}
        {activeTab === "bans" && (
          <>
            {selectedBan ? (
              <div className="channel-perm-section">
                {/* Ban detay başlığı */}
                <div className="member-settings-detail-header">
                  <div className="member-settings-avatar member-settings-avatar-lg member-settings-avatar-banned">
                    <span className="member-settings-avatar-fallback">
                      {selectedBan.username.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div className="member-settings-detail-name member-settings-name-banned">
                      {selectedBan.username}
                    </div>
                    <div className="member-settings-detail-username">
                      {t("bannedOn", { date: formatBanDate(selectedBan.created_at) })}
                    </div>
                  </div>
                </div>

                {/* Ban bilgileri */}
                <div className="settings-field">
                  <label className="settings-label">{t("banReason")}</label>
                  <p className="ban-detail-value">
                    {selectedBan.reason || t("noReasonProvided")}
                  </p>
                </div>

                <div className="settings-field">
                  <label className="settings-label">{t("bannedBy")}</label>
                  <p className="ban-detail-value">
                    {selectedBan.banned_by}
                  </p>
                </div>

                {/* Unban butonu */}
                <div className="member-settings-actions">
                  <button
                    onClick={handleUnban}
                    className="settings-btn"
                  >
                    {t("unban")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="no-channel">
                {t("selectBannedMember")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default MembersSettings;

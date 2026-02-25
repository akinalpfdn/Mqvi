/**
 * ChannelPermissionEditor — Bir kanalın permission override'larını düzenleme paneli.
 *
 * Layout: RoleSettings ile aynı single-column pattern'ı kullanır.
 * - Üstte: Rol seçim dropdown'ı (settings-input select)
 * - Altta: Seçili rol için tri-state permission toggle'ları
 *
 * Ortak: ViewChannel (hem text hem voice — sidebar görünürlüğü)
 * Text kanalları: SendMessages, ReadMessages, ManageMessages
 * Voice kanalları: ConnectVoice, Speak, Stream
 *
 * CSS class'ları: .perm-tri-*, .settings-field, .settings-label, .settings-input
 */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRoleStore } from "../../stores/roleStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useToastStore } from "../../stores/toastStore";
import { Permissions } from "../../utils/permissions";
import PermissionTriToggle, { type TriState } from "./PermissionTriToggle";
import type { Channel, ChannelPermissionOverride } from "../../types";

/** Ortak permission'lar — hem text hem voice kanallar için (sidebar görünürlüğü) */
const COMMON_PERM_DEFS = [
  { bit: Permissions.ViewChannel, label: "permViewChannel", desc: "permViewChannelDesc" },
] as const;

/** Text kanallarında override edilebilecek permission'lar */
const TEXT_PERM_DEFS = [
  { bit: Permissions.SendMessages, label: "permSendMessages", desc: "permSendMessagesDesc" },
  { bit: Permissions.ReadMessages, label: "permReadMessages", desc: "permReadMessagesDesc" },
  { bit: Permissions.ManageMessages, label: "permManageMessages", desc: "permManageMessagesDesc" },
] as const;

/** Voice kanallarında override edilebilecek permission'lar */
const VOICE_PERM_DEFS = [
  { bit: Permissions.ConnectVoice, label: "permConnect", desc: "permConnectDesc" },
  { bit: Permissions.Speak, label: "permSpeak", desc: "permSpeakDesc" },
  { bit: Permissions.Stream, label: "permStream", desc: "permStreamDesc" },
] as const;

type Props = {
  channel: Channel;
};

function ChannelPermissionEditor({ channel }: Props) {
  const { t } = useTranslation("settings");
  const { roles, fetchRoles } = useRoleStore();
  const { fetchOverrides, getOverrides, setOverride } = useChannelPermissionStore();
  const addToast = useToastStore((s) => s.addToast);

  const [selectedRoleId, setSelectedRoleId] = useState<string>("");

  // İlk yükleme: roller + bu kanalın override'ları
  useEffect(() => {
    fetchRoles();
    fetchOverrides(channel.id);
  }, [fetchRoles, fetchOverrides, channel.id]);

  // İlk rolü otomatik seç
  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
    }
  }, [selectedRoleId, roles]);

  const overrides = getOverrides(channel.id);
  const permDefs = channel.type === "voice"
    ? [...COMMON_PERM_DEFS, ...VOICE_PERM_DEFS]
    : [...COMMON_PERM_DEFS, ...TEXT_PERM_DEFS];

  // Seçili rol için override
  const currentOverride: ChannelPermissionOverride | undefined = overrides.find(
    (o) => o.role_id === selectedRoleId
  );

  /**
   * Bir permission bit'inin mevcut TriState değerini hesapla.
   *
   * - allow bit set → "allow"
   * - deny bit set → "deny"
   * - hiçbiri set değil → "inherit"
   */
  const getTriState = useCallback(
    (bit: number): TriState => {
      if (!currentOverride) return "inherit";
      if ((currentOverride.allow & bit) !== 0) return "allow";
      if ((currentOverride.deny & bit) !== 0) return "deny";
      return "inherit";
    },
    [currentOverride]
  );

  /**
   * Tri-state değiştiğinde yeni allow/deny hesapla ve API'ye gönder.
   *
   * Mantık:
   * - "allow" → allow |= bit, deny &= ~bit
   * - "deny"  → deny |= bit, allow &= ~bit
   * - "inherit" → allow &= ~bit, deny &= ~bit
   */
  async function handleTriChange(bit: number, newState: TriState) {
    if (!selectedRoleId) return;

    let allow = currentOverride?.allow ?? 0;
    let deny = currentOverride?.deny ?? 0;

    // Önce bu bit'i her iki taraftan temizle
    allow &= ~bit;
    deny &= ~bit;

    // Yeni state'e göre set et
    if (newState === "allow") allow |= bit;
    if (newState === "deny") deny |= bit;

    const success = await setOverride(channel.id, selectedRoleId, allow, deny);
    if (success) {
      addToast("success", t("channelPermSaved"));
    } else {
      addToast("error", t("channelPermSaveError"));
    }
  }

  // Seçili rolün rengi — dropdown'da görsel ipucu olarak
  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  return (
    <div>
      {/* Rol seçici — dropdown */}
      <div className="settings-field">
        <label className="settings-label">{t("roles")}</label>
        <div className="perm-tri-role-select">
          {selectedRole && (
            <span
              className="role-list-dot"
              style={{ backgroundColor: selectedRole.color || "#99AAB5" }}
            />
          )}
          <select
            className="settings-input perm-tri-role-dropdown"
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Açıklama */}
      <p className="perm-tri-section-desc">{t("channelPermDesc")}</p>

      {/* Permission override toggle'ları */}
      <div className="settings-field">
        <label className="settings-label">
          {channel.type === "voice" ? t("voicePermissions") : t("textPermissions")}
        </label>
        <div className="perm-tri-container">
          {permDefs.map((perm) => (
            <PermissionTriToggle
              key={perm.bit}
              permBit={perm.bit}
              labelKey={perm.label}
              descKey={perm.desc}
              state={getTriState(perm.bit)}
              onChange={handleTriChange}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default ChannelPermissionEditor;

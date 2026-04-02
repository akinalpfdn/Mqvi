/** ChannelPermissionEditor — Per-channel permission overrides with tri-state toggles per role. */

import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRoleStore, useActiveRoles } from "../../stores/roleStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useToastStore } from "../../stores/toastStore";
import { Permissions } from "../../utils/permissions";
import PermissionTriToggle, { type TriState } from "./PermissionTriToggle";
import type { Channel, ChannelPermissionOverride } from "../../types";

/** Shared permissions (text + voice) */
const COMMON_PERM_DEFS = [
  { bit: Permissions.ViewChannel, label: "permViewChannel", desc: "permViewChannelDesc" },
] as const;

/** Text channel overridable permissions */
const TEXT_PERM_DEFS = [
  { bit: Permissions.SendMessages, label: "permSendMessages", desc: "permSendMessagesDesc" },
  { bit: Permissions.ReadMessages, label: "permReadMessages", desc: "permReadMessagesDesc" },
  { bit: Permissions.ManageMessages, label: "permManageMessages", desc: "permManageMessagesDesc" },
] as const;

/** Voice channel overridable permissions */
const VOICE_PERM_DEFS = [
  { bit: Permissions.ConnectVoice, label: "permConnect", desc: "permConnectDesc" },
  { bit: Permissions.Speak, label: "permSpeak", desc: "permSpeakDesc" },
  { bit: Permissions.Stream, label: "permStream", desc: "permStreamDesc" },
  { bit: Permissions.MoveMembers, label: "permMoveMembers", desc: "permMoveMembersDesc" },
  { bit: Permissions.MuteMembers, label: "permMuteMembers", desc: "permMuteMembersDesc" },
  { bit: Permissions.DeafenMembers, label: "permDeafenMembers", desc: "permDeafenMembersDesc" },
] as const;

type Props = {
  channel: Channel;
};

function ChannelPermissionEditor({ channel }: Props) {
  const { t } = useTranslation("settings");
  const roles = useActiveRoles();
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const { fetchOverrides, getOverrides, setOverride } = useChannelPermissionStore();
  const addToast = useToastStore((s) => s.addToast);

  const [selectedRoleId, setSelectedRoleId] = useState<string>("");

  useEffect(() => {
    fetchRoles();
    fetchOverrides(channel.id);
  }, [fetchRoles, fetchOverrides, channel.id]);

  // Auto-select first role
  useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
    }
  }, [selectedRoleId, roles]);

  const overrides = getOverrides(channel.id);
  const permDefs = channel.type === "voice"
    ? [...COMMON_PERM_DEFS, ...VOICE_PERM_DEFS]
    : [...COMMON_PERM_DEFS, ...TEXT_PERM_DEFS];

  const currentOverride: ChannelPermissionOverride | undefined = overrides.find(
    (o) => o.role_id === selectedRoleId
  );

  const getTriState = useCallback(
    (bit: number): TriState => {
      if (!currentOverride) return "inherit";
      if ((currentOverride.allow & bit) !== 0) return "allow";
      if ((currentOverride.deny & bit) !== 0) return "deny";
      return "inherit";
    },
    [currentOverride]
  );

  async function handleTriChange(bit: number, newState: TriState) {
    if (!selectedRoleId) return;

    let allow = currentOverride?.allow ?? 0;
    let deny = currentOverride?.deny ?? 0;

    // Clear bit from both sides first
    allow &= ~bit;
    deny &= ~bit;

    if (newState === "allow") allow |= bit;
    if (newState === "deny") deny |= bit;

    const success = await setOverride(channel.id, selectedRoleId, allow, deny);
    if (success) {
      addToast("success", t("channelPermSaved"));
    } else {
      addToast("error", t("channelPermSaveError"));
    }
  }

  const selectedRole = roles.find((r) => r.id === selectedRoleId);

  return (
    <div>
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

      <p className="perm-tri-section-desc">{t("channelPermDesc")}</p>

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

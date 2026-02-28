/**
 * RoleEditorPopup — Inline rol düzenleme popup'ı.
 *
 * Üye listesinde sağ tık veya MemberCard'dan açılır.
 * Checkbox list ile roller atanır/çıkarılır.
 *
 * Hiyerarşi kuralları:
 * - Sadece actor'ün en yüksek rolünün altındaki roller düzenlenebilir
 * - Owner rolü her zaman disabled
 * - Default (member) rolü her zaman checked + disabled
 * - Save → modifyMemberRoles API çağrısı
 *
 * CSS class'ları: .role-editor-popup, .role-editor-title,
 * .role-editor-list, .role-editor-item, .role-editor-item.disabled,
 * .role-editor-dot, .role-editor-actions, .role-editor-save
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useRoleStore } from "../../stores/roleStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import type { MemberWithRoles } from "../../types";

type RoleEditorPopupProps = {
  /** Düzenlenecek üye */
  member: MemberWithRoles;
  /** Popup pozisyonu (viewport px) */
  position: { top: number; left: number };
  /** Kapatma callback'i */
  onClose: () => void;
};

function RoleEditorPopup({ member, position, onClose }: RoleEditorPopupProps) {
  const { t } = useTranslation("common");
  const addToast = useToastStore((s) => s.addToast);
  const roles = useRoleStore((s) => s.roles);
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const popupRef = useRef<HTMLDivElement>(null);

  /**
   * Mount'ta rolleri fetch et — roleStore Settings paneli dışında
   * boş olabilir. Bu sayede popup her açıldığında güncel roller yüklenir.
   */
  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  // Üyenin mevcut rol ID'leri
  const [editRoleIds, setEditRoleIds] = useState<string[]>(() =>
    member.roles.map((r) => r.id)
  );
  const [isSaving, setIsSaving] = useState(false);

  // Actor'ün en yüksek rol position'ı — hiyerarşi kontrolü
  const actorMaxPos = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    if (!me || me.roles.length === 0) return 0;
    return Math.max(...me.roles.map((r) => r.position));
  }, [members, currentUser]);

  // Değişiklik var mı?
  const originalRoleIds = useMemo(
    () => new Set(member.roles.map((r) => r.id)),
    [member.roles]
  );
  const hasChanges = useMemo(() => {
    const currentSet = new Set(editRoleIds);
    if (currentSet.size !== originalRoleIds.size) return true;
    for (const id of editRoleIds) {
      if (!originalRoleIds.has(id)) return true;
    }
    return false;
  }, [editRoleIds, originalRoleIds]);

  // Düzenlenebilir roller — owner ve default hariç, actor'ün altında
  const editableRoles = useMemo(
    () =>
      roles
        .filter((r) => r.id !== "owner" && !r.is_default && r.position < actorMaxPos)
        .sort((a, b) => b.position - a.position),
    [roles, actorMaxPos]
  );

  // Dışarı tıkla → kapat
  useEffect(() => {
    let frameId: number;

    function handleClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    frameId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // ESC ile kapat
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleToggle(roleId: string) {
    setEditRoleIds((prev) =>
      prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId]
    );
  }

  async function handleSave() {
    if (!hasChanges || isSaving) return;
    setIsSaving(true);

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await memberApi.modifyMemberRoles(serverId, member.id, editRoleIds);
    if (res.data) {
      addToast("success", t("success"));
      onClose();
    } else {
      addToast("error", t("somethingWentWrong"));
    }

    setIsSaving(false);
  }

  // Popup pozisyonunu viewport içinde tut
  const adjustedPos = useMemo(() => {
    const popupWidth = 240;
    const popupHeight = Math.min(editableRoles.length * 40 + 100, 360);
    let { top, left } = position;

    if (left + popupWidth > window.innerWidth - 8) {
      left = window.innerWidth - popupWidth - 8;
    }
    if (left < 8) left = 8;

    if (top + popupHeight > window.innerHeight - 8) {
      top = window.innerHeight - popupHeight - 8;
    }
    if (top < 8) top = 8;

    return { top, left };
  }, [position, editableRoles.length]);

  return createPortal(
    <div
      ref={popupRef}
      className="role-editor-popup"
      style={{ top: adjustedPos.top, left: adjustedPos.left }}
    >
      <div className="role-editor-title">{t("editRoles")}</div>

      <div className="role-editor-list">
        {editableRoles.length === 0 && (
          <div className="role-editor-empty">{t("noRoles")}</div>
        )}
        {editableRoles.map((role) => (
          <label key={role.id} className="role-editor-item">
            <input
              type="checkbox"
              checked={editRoleIds.includes(role.id)}
              onChange={() => handleToggle(role.id)}
            />
            <span
              className="role-editor-dot"
              style={{ backgroundColor: role.color || "#99AAB5" }}
            />
            <span>{role.name}</span>
          </label>
        ))}
      </div>

      <div className="role-editor-actions">
        <button
          className="role-editor-save"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving ? t("loading") : t("save")}
        </button>
      </div>
    </div>,
    document.body
  );
}

export default RoleEditorPopup;

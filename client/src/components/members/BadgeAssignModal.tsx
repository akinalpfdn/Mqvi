/** BadgeAssignModal — Placeholder modal for badge assignment. */

import { useTranslation } from "react-i18next";
import Modal from "../shared/Modal";
import type { MemberWithRoles } from "../../types";

type BadgeAssignModalProps = {
  member: MemberWithRoles;
  onClose: () => void;
};

function BadgeAssignModal({ member, onClose }: BadgeAssignModalProps) {
  const { t } = useTranslation("common");
  const displayName = member.display_name ?? member.username;

  return (
    <Modal isOpen onClose={onClose} title={t("assignBadge")}>
      <div className="badge-assign-placeholder">
        <p>{t("assignBadgePlaceholder", { username: displayName })}</p>
      </div>
    </Modal>
  );
}

export default BadgeAssignModal;

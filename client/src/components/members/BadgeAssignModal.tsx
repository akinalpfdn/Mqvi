/**
 * BadgeAssignModal — Two-screen modal for badge management.
 *
 * Screen 1 (Assign): Shows existing badge templates in a grid. Click to assign/unassign.
 *   Already-assigned badges are highlighted. Max 3 per user enforced.
 *   "+ Create New Badge" button switches to Screen 2.
 *
 * Screen 2 (Create): Name input, icon picker (built-in SVG grid OR custom upload),
 *   color picker (solid or gradient), live preview pill, Create button.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../shared/Modal";
import { useBadgeStore } from "../../stores/badgeStore";
import { BADGE_ICONS, getBadgeIcon } from "../../utils/badgeIcons";
import * as badgeApi from "../../api/badges";
import type { MemberWithRoles, Badge } from "../../types";

const MAX_BADGES_PER_USER = 3;

/** Default colors for the color picker palette. */
const COLOR_PRESETS = [
  "#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245",
  "#FF7B3A", "#9B59B6", "#1ABC9C", "#3498DB", "#E91E63",
  "#2ECC71", "#E67E22", "#95A5A6", "#607D8B", "#F44336",
  "#00BCD4",
];

type BadgeAssignModalProps = {
  member: MemberWithRoles;
  onClose: () => void;
};

type Screen = "assign" | "create";
type IconTab = "builtin" | "custom";

function BadgeAssignModal({ member, onClose }: BadgeAssignModalProps) {
  const { t } = useTranslation("common");
  const displayName = member.display_name ?? member.username;

  const [screen, setScreen] = useState<Screen>("assign");

  // ── Assign screen state ──
  const badges = useBadgeStore((s) => s.badges);
  const loaded = useBadgeStore((s) => s.loaded);
  const userBadgesMap = useBadgeStore((s) => s.userBadgesMap);
  const userBadges = userBadgesMap[member.id] ?? [];
  const assignedIds = new Set(userBadges.map((ub) => ub.badge_id));
  const [assigning, setAssigning] = useState<string | null>(null);

  // ── Create screen state ──
  const [badgeName, setBadgeName] = useState("");
  const [iconTab, setIconTab] = useState<IconTab>("builtin");
  const [selectedIcon, setSelectedIcon] = useState("star");
  const [customIconUrl, setCustomIconUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [color1, setColor1] = useState("#5865F2");
  const [color2, setColor2] = useState<string | null>(null);
  const [useGradient, setUseGradient] = useState(false);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch badge templates + user badges on mount
  useEffect(() => {
    if (!loaded) useBadgeStore.getState().fetchBadges();
    useBadgeStore.getState().fetchUserBadges(member.id);
  }, [loaded, member.id]);

  // ── Assign / Unassign handlers ──
  async function handleToggleBadge(badge: Badge) {
    if (assigning) return;
    setAssigning(badge.id);

    if (assignedIds.has(badge.id)) {
      await useBadgeStore.getState().unassignBadge(badge.id, member.id);
    } else {
      if (userBadges.length >= MAX_BADGES_PER_USER) {
        setAssigning(null);
        return;
      }
      await useBadgeStore.getState().assignBadge(badge.id, member.id);
    }
    setAssigning(null);
  }

  async function handleDeleteBadge(badgeId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await useBadgeStore.getState().deleteBadge(badgeId);
  }

  // ── Create handlers ──
  async function handleUploadIcon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const res = await badgeApi.uploadBadgeIcon(file);
    if (res.success && res.data) {
      setCustomIconUrl(res.data.url);
      setIconTab("custom");
    }
    setUploading(false);
  }

  async function handleCreate() {
    if (!badgeName.trim() || creating) return;

    const icon = iconTab === "builtin" ? selectedIcon : customIconUrl;
    if (!icon) return;

    setCreating(true);
    await useBadgeStore.getState().createBadge({
      name: badgeName.trim(),
      icon,
      icon_type: iconTab,
      color1,
      color2: useGradient ? color2 : null,
    });
    setCreating(false);

    // Go back to assign screen
    setBadgeName("");
    setSelectedIcon("star");
    setCustomIconUrl("");
    setUseGradient(false);
    setScreen("assign");
  }

  /** Resolve badge background style (solid or gradient). */
  function badgeBg(c1: string, c2: string | null): React.CSSProperties {
    if (c2) {
      return { background: `linear-gradient(135deg, ${c1}, ${c2})` };
    }
    return { background: c1 };
  }

  /** Render a badge icon (builtin SVG or custom image). */
  function renderBadgeIcon(badge: Badge) {
    if (badge.icon_type === "builtin") {
      const def = getBadgeIcon(badge.icon);
      return def ? def.svg : null;
    }
    return <img src={badge.icon} alt="" className="bam-custom-icon" />;
  }

  // ── Render: Assign screen ──
  function renderAssignScreen() {
    const atMax = userBadges.length >= MAX_BADGES_PER_USER;

    return (
      <div className="bam-assign">
        <p className="bam-subtitle">
          {t("badgeAssignDesc", { username: displayName })}
        </p>

        {/* Currently assigned badges */}
        {userBadges.length > 0 && (
          <div className="bam-assigned-section">
            <div className="bam-section-label">{t("badgeAssigned")}</div>
            <div className="bam-assigned-pills">
              {userBadges.map((ub) => {
                const badge = ub.badge ?? badges.find((b) => b.id === ub.badge_id);
                if (!badge) return null;
                return (
                  <span
                    key={ub.id}
                    className="bam-pill"
                    style={badgeBg(badge.color1, badge.color2 ?? null)}
                  >
                    <span className="bam-pill-icon">{renderBadgeIcon(badge)}</span>
                    <span className="bam-pill-name">{badge.name}</span>
                    <button
                      className="bam-pill-remove"
                      title={t("badgeUnassign")}
                      onClick={() => handleToggleBadge(badge)}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="bam-limit-hint">
              {t("badgeLimitHint", { count: userBadges.length, max: MAX_BADGES_PER_USER })}
            </div>
          </div>
        )}

        {/* Available badges grid */}
        <div className="bam-section-label">{t("badgeAvailable")}</div>
        {badges.length === 0 ? (
          <p className="bam-empty">{t("badgeNoneCreated")}</p>
        ) : (
          <div className="bam-grid">
            {badges.map((badge) => {
              const isAssigned = assignedIds.has(badge.id);
              const disabled = !isAssigned && atMax;
              return (
                <button
                  key={badge.id}
                  className={`bam-badge-card${isAssigned ? " assigned" : ""}${disabled ? " disabled" : ""}`}
                  onClick={() => !disabled && handleToggleBadge(badge)}
                  disabled={!!assigning}
                >
                  <div className="bam-badge-preview" style={badgeBg(badge.color1, badge.color2 ?? null)}>
                    <span className="bam-badge-icon">{renderBadgeIcon(badge)}</span>
                  </div>
                  <span className="bam-badge-name">{badge.name}</span>
                  {isAssigned && (
                    <span className="bam-badge-check">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  )}
                  <button
                    className="bam-badge-delete"
                    title={t("delete")}
                    onClick={(e) => handleDeleteBadge(badge.id, e)}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </button>
              );
            })}
          </div>
        )}

        {/* Create new badge button */}
        <button className="bam-create-btn" onClick={() => setScreen("create")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{t("badgeCreateNew")}</span>
        </button>
      </div>
    );
  }

  // ── Render: Create screen ──
  function renderCreateScreen() {
    const previewIcon = iconTab === "builtin"
      ? getBadgeIcon(selectedIcon)?.svg
      : customIconUrl
        ? <img src={customIconUrl} alt="" className="bam-custom-icon" />
        : null;

    const previewBg = badgeBg(color1, useGradient ? color2 : null);
    const canCreate = badgeName.trim().length > 0 && (iconTab === "builtin" || customIconUrl);

    return (
      <div className="bam-create">
        {/* Back button */}
        <button className="bam-back-btn" onClick={() => setScreen("assign")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{t("back")}</span>
        </button>

        {/* Live preview */}
        <div className="bam-preview-area">
          <div className="bam-section-label">{t("badgePreview")}</div>
          <span className="bam-pill bam-pill-preview" style={previewBg}>
            {previewIcon && <span className="bam-pill-icon">{previewIcon}</span>}
            <span className="bam-pill-name">{badgeName || t("badgeNamePlaceholder")}</span>
          </span>
        </div>

        {/* Name input */}
        <div className="bam-field">
          <label className="bam-field-label">{t("badgeName")}</label>
          <input
            className="bam-input"
            type="text"
            maxLength={20}
            value={badgeName}
            onChange={(e) => setBadgeName(e.target.value)}
            placeholder={t("badgeNamePlaceholder")}
            autoFocus
          />
        </div>

        {/* Icon picker */}
        <div className="bam-field">
          <label className="bam-field-label">{t("badgeIcon")}</label>
          <div className="bam-icon-tabs">
            <button
              className={`bam-icon-tab${iconTab === "builtin" ? " active" : ""}`}
              onClick={() => setIconTab("builtin")}
            >
              {t("badgeIconBuiltin")}
            </button>
            <button
              className={`bam-icon-tab${iconTab === "custom" ? " active" : ""}`}
              onClick={() => setIconTab("custom")}
            >
              {t("badgeIconCustom")}
            </button>
          </div>

          {iconTab === "builtin" ? (
            <div className="bam-icon-grid">
              {BADGE_ICONS.map((icon) => (
                <button
                  key={icon.key}
                  className={`bam-icon-cell${selectedIcon === icon.key ? " selected" : ""}`}
                  onClick={() => setSelectedIcon(icon.key)}
                  title={icon.label}
                >
                  {icon.svg}
                </button>
              ))}
            </div>
          ) : (
            <div className="bam-upload-area">
              {customIconUrl ? (
                <div className="bam-upload-preview">
                  <img src={customIconUrl} alt="" className="bam-upload-img" />
                  <button
                    className="bam-upload-change"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t("badgeIconChange")}
                  </button>
                </div>
              ) : (
                <button
                  className="bam-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>{uploading ? t("uploading") : t("badgeIconUpload")}</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                className="bam-file-input"
                onChange={handleUploadIcon}
              />
            </div>
          )}
        </div>

        {/* Color picker */}
        <div className="bam-field">
          <label className="bam-field-label">{t("badgeColor")}</label>

          {/* Gradient toggle */}
          <label className="bam-gradient-toggle">
            <input
              type="checkbox"
              checked={useGradient}
              onChange={(e) => {
                setUseGradient(e.target.checked);
                if (e.target.checked && !color2) setColor2("#EB459E");
              }}
            />
            <span>{t("badgeGradient")}</span>
          </label>

          {/* Color 1 */}
          <div className="bam-color-row">
            <span className="bam-color-label">{useGradient ? t("badgeColorStart") : t("badgeColor")}</span>
            <div className="bam-color-presets">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  className={`bam-color-swatch${color1 === c ? " selected" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor1(c)}
                />
              ))}
            </div>
            <input
              type="color"
              className="bam-color-input"
              value={color1}
              onChange={(e) => setColor1(e.target.value)}
            />
          </div>

          {/* Color 2 (gradient) */}
          {useGradient && (
            <div className="bam-color-row">
              <span className="bam-color-label">{t("badgeColorEnd")}</span>
              <div className="bam-color-presets">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    className={`bam-color-swatch${color2 === c ? " selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => setColor2(c)}
                  />
                ))}
              </div>
              <input
                type="color"
                className="bam-color-input"
                value={color2 ?? "#EB459E"}
                onChange={(e) => setColor2(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Create button */}
        <button
          className="bam-submit-btn"
          disabled={!canCreate || creating}
          onClick={handleCreate}
        >
          {creating ? t("loading") : t("badgeCreate")}
        </button>
      </div>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title={screen === "assign" ? t("assignBadge") : t("badgeCreateTitle")}>
      {screen === "assign" ? renderAssignScreen() : renderCreateScreen()}
    </Modal>
  );
}

export default BadgeAssignModal;

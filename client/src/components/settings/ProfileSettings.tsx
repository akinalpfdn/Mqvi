/**
 * ProfileSettings — Kullanıcı profil ayarları sekmesi.
 *
 * CSS class'ları: .settings-section-title, .settings-field,
 * .settings-label, .settings-input, .settings-btn
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import * as profileApi from "../../api/profile";
import AvatarUpload from "./AvatarUpload";
import LanguageSelector from "./LanguageSelector";

function ProfileSettings() {
  const { t } = useTranslation("settings");
  const { i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const addToast = useToastStore((s) => s.addToast);

  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [customStatus, setCustomStatus] = useState(user?.custom_status ?? "");
  const [pendingLanguage, setPendingLanguage] = useState(user?.language ?? "en");
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const prevPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    setDisplayName(user?.display_name ?? "");
    setCustomStatus(user?.custom_status ?? "");
    setPendingLanguage(user?.language ?? "en");
    setPendingAvatarFile(null);
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
      prevPreviewUrlRef.current = null;
    }
    setAvatarPreviewUrl(null);
  }, [user?.display_name, user?.custom_status, user?.language, user?.avatar_url]);

  useEffect(() => {
    return () => {
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
      }
    };
  }, []);

  const hasChanges =
    displayName !== (user?.display_name ?? "") ||
    customStatus !== (user?.custom_status ?? "") ||
    pendingAvatarFile !== null ||
    pendingLanguage !== (user?.language ?? "en");

  async function handleAvatarSelect(file: File) {
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
    }
    const previewUrl = URL.createObjectURL(file);
    prevPreviewUrlRef.current = previewUrl;
    setPendingAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
  }

  function handleLanguageChange(language: string) {
    setPendingLanguage(language);
  }

  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      if (pendingAvatarFile) {
        const avatarRes = await profileApi.uploadAvatar(pendingAvatarFile);
        if (avatarRes.success && avatarRes.data) {
          updateUser({ avatar_url: avatarRes.data.avatar_url });
        } else {
          addToast("error", avatarRes.error ?? t("avatarUploadError"));
          setIsSaving(false);
          return;
        }
      }

      const profileChanged =
        displayName !== (user?.display_name ?? "") ||
        customStatus !== (user?.custom_status ?? "") ||
        pendingLanguage !== (user?.language ?? "en");

      if (profileChanged) {
        const res = await profileApi.updateProfile({
          display_name: displayName || null,
          custom_status: customStatus || null,
          language: pendingLanguage,
        });

        if (res.success && res.data) {
          if (pendingLanguage !== (user?.language ?? "en")) {
            i18n.changeLanguage(pendingLanguage);
          }
          updateUser({
            display_name: res.data.display_name,
            custom_status: res.data.custom_status,
            language: pendingLanguage,
          });
        } else {
          addToast("error", res.error ?? t("profileSaveError"));
          setIsSaving(false);
          return;
        }
      }

      setPendingAvatarFile(null);
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
        prevPreviewUrlRef.current = null;
      }
      setAvatarPreviewUrl(null);
      addToast("success", t("profileSaved"));
    } catch {
      addToast("error", t("profileSaveError"));
    } finally {
      setIsSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("profile")}</h2>

      {/* Avatar yükleme */}
      <AvatarUpload
        currentUrl={user.avatar_url}
        previewUrl={avatarPreviewUrl}
        fallbackText={user.display_name ?? user.username}
        onUpload={handleAvatarSelect}
      />

      {/* Display Name */}
      <div className="settings-field">
        <label htmlFor="displayName" className="settings-label">
          {t("displayName")}
        </label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t("displayNamePlaceholder")}
          maxLength={32}
          className="settings-input"
        />
      </div>

      {/* Custom Status */}
      <div className="settings-field">
        <label htmlFor="customStatus" className="settings-label">
          {t("customStatus")}
        </label>
        <input
          id="customStatus"
          type="text"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          placeholder={t("customStatusPlaceholder")}
          maxLength={128}
          className="settings-input"
        />
      </div>

      {/* Dil Seçimi */}
      <LanguageSelector
        currentLanguage={pendingLanguage}
        onChange={handleLanguageChange}
      />

      {/* Separator */}
      <div style={{ height: 1, background: "var(--b1)", margin: "24px 0" }} />

      {/* Save */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="settings-btn"
        >
          {isSaving ? t("saveChanges") + "..." : t("saveChanges")}
        </button>
        {hasChanges && (
          <span style={{ fontSize: 13, color: "var(--primary)" }}>{t("unsavedChanges")}</span>
        )}
      </div>
    </div>
  );
}

export default ProfileSettings;

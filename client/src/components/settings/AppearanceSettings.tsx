/** AppearanceSettings — Theme selection grid with color swatch previews. */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { uploadWallpaper, deleteWallpaper } from "../../api/profile";
import { resolveAssetUrl } from "../../utils/constants";
import { clearWallpaperCache } from "../../utils/wallpaperCache";
import { THEMES, THEME_ORDER, type ThemeId } from "../../styles/themes";
import { isElectron } from "../../utils/constants";

function AppearanceSettings() {
  const { t } = useTranslation("settings");
  const themeId = useSettingsStore((s) => s.themeId);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const blurEnabled = useSettingsStore((s) => s.blurEnabled);
  const setBlurEnabled = useSettingsStore((s) => s.setBlurEnabled);
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const setWallpaperEnabled = useSettingsStore((s) => s.setWallpaperEnabled);
  const transparentBackground = useSettingsStore((s) => s.transparentBackground);
  const setTransparentBackground = useSettingsStore((s) => s.setTransparentBackground);
  const setPendingWallpaperPreviewUrl = useSettingsStore((s) => s.setPendingWallpaperPreviewUrl);
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const addToast = useToastStore((s) => s.addToast);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);

  function handleWallpaperSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    const blobUrl = URL.createObjectURL(file);
    setPendingFile(file);
    setPendingPreviewUrl(blobUrl);
    setPendingWallpaperPreviewUrl(blobUrl);
  }

  function handleCancelPending() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(null);
    setPendingPreviewUrl(null);
    setPendingWallpaperPreviewUrl(null);
  }

  async function handleSavePending() {
    if (!pendingFile) return;

    setIsUploading(true);
    const res = await uploadWallpaper(pendingFile);
    setIsUploading(false);

    if (res.success && res.data) {
      await clearWallpaperCache();
      updateUser({ wallpaper_url: res.data.wallpaper_url });
      setPendingWallpaperPreviewUrl(null);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      setPendingFile(null);
      setPendingPreviewUrl(null);
      addToast("success", t("wallpaperUpdated"));
    } else {
      addToast("error", t("wallpaperUploadError"));
    }
  }

  async function handleRemoveWallpaper() {
    const res = await deleteWallpaper();
    if (res.success) {
      await clearWallpaperCache();
      updateUser({ wallpaper_url: null });
      addToast("success", t("wallpaperRemoved"));
    } else {
      addToast("error", t("wallpaperRemoveError"));
    }
  }

  function handleSelectTheme(id: ThemeId) {
    setTheme(id);
  }

  return (
    <div>
      <h2 className="settings-section-title">{t("blurTitle")}</h2>
      <p className="theme-section-desc">{t("blurDescription")}</p>
      <label className="settings-toggle-row">
        <span>{t("blurTitle")}</span>
        <button
          className={`ub-switch${blurEnabled ? " active" : ""}`}
          onClick={() => setBlurEnabled(!blurEnabled)}
          role="switch"
          aria-checked={blurEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>

      {isElectron() && (
        <>
          <h2 className="settings-section-title" style={{ marginTop: 24 }}>{t("transparentTitle")}</h2>
          <p className="theme-section-desc">{t("transparentDescription")}</p>
          <label className="settings-toggle-row">
            <span>{t("transparentEnable")}</span>
            <button
              className={`ub-switch${transparentBackground ? " active" : ""}`}
              onClick={() => setTransparentBackground(!transparentBackground)}
              role="switch"
              aria-checked={transparentBackground}
              type="button"
            >
              <span className="ub-switch-thumb" />
            </button>
          </label>
          {transparentBackground && (
            <p className="theme-section-desc" style={{ color: "var(--yellow)", marginTop: 4 }}>{t("transparentRestart")}</p>
          )}
        </>
      )}

      <h2 className="settings-section-title" style={{ marginTop: 24 }}>{t("wallpaperTitle")}</h2>
      <p className="theme-section-desc">{t("wallpaperDescription")}</p>
      <label className="settings-toggle-row">
        <span>{t("wallpaperEnable")}</span>
        <button
          className={`ub-switch${wallpaperEnabled ? " active" : ""}`}
          onClick={() => setWallpaperEnabled(!wallpaperEnabled)}
          role="switch"
          aria-checked={wallpaperEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>
      <div className="wallpaper-row">
        {pendingPreviewUrl ? (
          <img src={pendingPreviewUrl} alt="" className="wallpaper-preview" />
        ) : user?.wallpaper_url ? (
          <img src={resolveAssetUrl(user.wallpaper_url)} alt="" className="wallpaper-preview" />
        ) : null}
        <div className="wallpaper-actions">
          {pendingFile ? (
            <>
              <button
                type="button"
                className="settings-btn"
                onClick={handleSavePending}
                disabled={isUploading}
              >
                {isUploading ? t("loading") : t("saveChanges")}
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-secondary"
                onClick={handleCancelPending}
                disabled={isUploading}
              >
                {t("cancel", { ns: "common" })}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="settings-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                {user?.wallpaper_url ? t("wallpaperChange") : t("wallpaperChoose")}
              </button>
              {user?.wallpaper_url && (
                <button
                  type="button"
                  className="settings-btn settings-btn-danger"
                  onClick={handleRemoveWallpaper}
                >
                  {t("wallpaperRemove")}
                </button>
              )}
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={handleWallpaperSelect}
        />
      </div>

      <h2 className="settings-section-title" style={{ marginTop: 24 }}>{t("themeTitle")}</h2>
      <p className="theme-section-desc">{t("themeDescription")}</p>

      <div className="theme-grid">
        {THEME_ORDER.map((id) => {
          const theme = THEMES[id];
          const isActive = id === themeId;

          return (
            <button
              key={id}
              className={`theme-card${isActive ? " theme-card-active" : ""}`}
              onClick={() => handleSelectTheme(id)}
              type="button"
            >
              {/* Color swatch preview */}
              <div className="theme-swatches">
                {theme.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="theme-swatch"
                    style={{ background: color }}
                  />
                ))}
              </div>

              {/* Theme info */}
              <span className="theme-card-name">{t(theme.nameKey)}</span>
              <span className="theme-card-desc">{t(theme.descKey)}</span>

              {/* Active indicator */}
              {isActive && <span className="theme-card-check">&#10003;</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default AppearanceSettings;

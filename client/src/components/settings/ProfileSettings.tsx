/**
 * ProfileSettings — Kullanıcı profil ayarları sekmesi.
 *
 * Bu sekme Settings modal'ının "Profile" tab'ında gösterilir.
 *
 * İçerik:
 * 1. Avatar yükleme (AvatarUpload bileşeni)
 * 2. Display Name — diğerlerinin gördüğü isim (max 32 karakter)
 * 3. Custom Status — kişisel durum mesajı (max 128 karakter)
 * 4. Language — dil seçimi (EN/TR)
 * 5. Save Changes butonu — sadece değişiklik varsa aktif
 *
 * State yönetimi:
 * - TÜM form state'i component-local (useState) — henüz kaydedilmemiş değişiklikler
 * - Avatar dosya seçimi local state'te tutulur, URL.createObjectURL ile preview gösterilir
 * - Dil seçimi de local state'te tutulur, Save'e basılana kadar i18n değişmez
 * - Kayıt sonrası authStore.updateUser() ile global state güncellenir
 *
 * Unsaved changes uyarısı:
 * hasChanges flag'i ile "Save Changes" butonu etkinleştirilir,
 * kullanıcıya kaydedilmemiş değişiklikleri olduğu gösterilir.
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

  // ─── Form State (component-local) ───
  // Tüm değişiklikler burada tutulur, Save'e basılana kadar sunucuya gitmez.
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [customStatus, setCustomStatus] = useState(user?.custom_status ?? "");
  const [pendingLanguage, setPendingLanguage] = useState(user?.language ?? "en");
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // ObjectURL bellek sızıntısını önlemek için ref ile takip
  // URL.createObjectURL() tarayıcıda bir Blob referansı oluşturur —
  // component unmount olurken veya yeni dosya seçildiğinde revoke edilmeli.
  const prevPreviewUrlRef = useRef<string | null>(null);

  // User değiştiğinde form'u senkronize et
  // (başka bir yerden user güncellenirse — ör: WS member_update event'i)
  useEffect(() => {
    setDisplayName(user?.display_name ?? "");
    setCustomStatus(user?.custom_status ?? "");
    setPendingLanguage(user?.language ?? "en");
    // Save sonrası avatar state'ini de sıfırla
    setPendingAvatarFile(null);
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
      prevPreviewUrlRef.current = null;
    }
    setAvatarPreviewUrl(null);
  }, [user?.display_name, user?.custom_status, user?.language, user?.avatar_url]);

  // Component unmount'ta preview URL'i temizle
  useEffect(() => {
    return () => {
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
      }
    };
  }, []);

  // ─── Kaydedilmemiş değişiklik var mı? ───
  // 4 alan kontrol edilir: display name, custom status, avatar, dil
  const hasChanges =
    displayName !== (user?.display_name ?? "") ||
    customStatus !== (user?.custom_status ?? "") ||
    pendingAvatarFile !== null ||
    pendingLanguage !== (user?.language ?? "en");

  // ─── Avatar Dosya Seçimi (henüz upload yok) ───
  // Dosya local state'e kaydedilir ve objectURL ile önizleme gösterilir.
  // Gerçek upload handleSave() içinde yapılır.
  async function handleAvatarSelect(file: File) {
    // Önceki preview URL'i temizle (bellek sızıntısı önleme)
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
    }

    const previewUrl = URL.createObjectURL(file);
    prevPreviewUrlRef.current = previewUrl;

    setPendingAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
  }

  // ─── Dil Seçimi (henüz uygulanmıyor) ───
  // Sadece local state güncellenir. Save'de i18n.changeLanguage() + API çağrılır.
  function handleLanguageChange(language: string) {
    setPendingLanguage(language);
  }

  // ─── Profil Kaydet ───
  // Tüm değişiklikleri tek seferde uygular:
  // 1. Avatar varsa → upload
  // 2. Profil bilgileri (name, status, language) → PATCH
  // 3. Dil değiştiyse → i18n.changeLanguage()
  // 4. authStore güncelle
  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      // ── Adım 1: Avatar upload (eğer yeni dosya seçildiyse) ──
      if (pendingAvatarFile) {
        const avatarRes = await profileApi.uploadAvatar(pendingAvatarFile);
        if (avatarRes.success && avatarRes.data) {
          updateUser({ avatar_url: avatarRes.data.avatar_url });
        } else {
          addToast("error", avatarRes.error ?? t("avatarUploadError"));
          setIsSaving(false);
          return; // Avatar upload başarısızsa devam etme
        }
      }

      // ── Adım 2: Profil bilgilerini güncelle (name, status, language) ──
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
          // ── Adım 3: Dil değiştiyse i18next'i güncelle ──
          if (pendingLanguage !== (user?.language ?? "en")) {
            i18n.changeLanguage(pendingLanguage);
          }

          // ── Adım 4: authStore'daki user'ı güncelle ──
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

      // Tüm işlemler başarılı — pending state'leri sıfırla
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
    <div className="flex flex-col gap-8">
      {/* Başlık */}
      <h2 className="text-xl font-semibold text-text-primary">{t("profile")}</h2>

      {/* Avatar yükleme — previewUrl ile henüz kaydedilmemiş seçim gösterilir */}
      <AvatarUpload
        currentUrl={user.avatar_url}
        previewUrl={avatarPreviewUrl}
        fallbackText={user.display_name ?? user.username}
        onUpload={handleAvatarSelect}
      />

      {/* Display Name */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="displayName"
          className="text-sm font-medium text-text-primary"
        >
          {t("displayName")}
        </label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t("displayNamePlaceholder")}
          maxLength={32}
          className="w-full max-w-md rounded-md bg-input px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none transition-colors focus:bg-input-focus"
        />
      </div>

      {/* Custom Status */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="customStatus"
          className="text-sm font-medium text-text-primary"
        >
          {t("customStatus")}
        </label>
        <input
          id="customStatus"
          type="text"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          placeholder={t("customStatusPlaceholder")}
          maxLength={128}
          className="w-full max-w-md rounded-md bg-input px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none transition-colors focus:bg-input-focus"
        />
      </div>

      {/* Dil Seçimi — pendingLanguage gösterilir, Save'e kadar uygulanmaz */}
      <LanguageSelector
        currentLanguage={pendingLanguage}
        onChange={handleLanguageChange}
      />

      {/* Ayırıcı çizgi */}
      <div className="border-t border-background-tertiary" />

      {/* Save Changes butonu */}
      <div className="flex items-center gap-4">
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="rounded-md bg-brand px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? t("saveChanges") + "..." : t("saveChanges")}
        </button>

        {/* Unsaved changes uyarısı */}
        {hasChanges && (
          <p className="text-sm text-warning">{t("unsavedChanges")}</p>
        )}
      </div>
    </div>
  );
}

export default ProfileSettings;

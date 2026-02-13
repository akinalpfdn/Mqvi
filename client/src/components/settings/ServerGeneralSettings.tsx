/**
 * ServerGeneralSettings — Sunucu genel ayarları sekmesi.
 *
 * Settings modal'ında "General" (Server Settings) tab'ında gösterilir.
 * Admin yetkisi gerektiren bu sekme, SettingsNav tarafından
 * sadece ilgili yetkiye sahip kullanıcılara gösterilir.
 *
 * İçerik:
 * 1. Sunucu ikonu yükleme (AvatarUpload bileşeni, köşeli mod)
 * 2. Sunucu adı — text input (max 100 karakter)
 * 3. Save Changes butonu — sadece değişiklik varsa aktif
 *
 * Veri akışı:
 * - Mount'ta sunucu bilgisi API'den çekilir
 * - İkon yükleme ayrı endpoint'e gider (anında kayıt)
 * - Ad değişikliği form submit ile kaydedilir
 * - WS server_update event'i Sidebar header'ı anında günceller
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import * as serverApi from "../../api/server";
import AvatarUpload from "./AvatarUpload";
import type { Server } from "../../types";

function ServerGeneralSettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  // ─── Server State ───
  const [server, setServer] = useState<Server | null>(null);
  const [editName, setEditName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Mount'ta sunucu bilgisini çek
  useEffect(() => {
    async function fetchServer() {
      const res = await serverApi.getServer();
      if (res.success && res.data) {
        setServer(res.data);
        setEditName(res.data.name);
      }
      setIsLoaded(true);
    }
    fetchServer();
  }, []);

  // Kaydedilmemiş değişiklik var mı?
  const hasChanges = server !== null && editName !== server.name;

  // ─── Sunucu Adı Kaydet ───
  async function handleSave() {
    if (!hasChanges || isSaving) return;

    setIsSaving(true);
    try {
      const res = await serverApi.updateServer({ name: editName });

      if (res.success && res.data) {
        setServer(res.data);
        addToast("success", t("serverSaved"));
      } else {
        addToast("error", res.error ?? t("serverSaveError"));
      }
    } catch {
      addToast("error", t("serverSaveError"));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── İkon Upload ───
  async function handleIconUpload(file: File) {
    try {
      const res = await serverApi.uploadServerIcon(file);

      if (res.success && res.data) {
        setServer(res.data);
        addToast("success", t("serverSaved"));
      } else {
        addToast("error", res.error ?? t("serverSaveError"));
      }
    } catch {
      addToast("error", t("serverSaveError"));
    }
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        {t("loading", { ns: "common" })}
      </div>
    );
  }

  if (!server) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        {t("serverSaveError")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Başlık */}
      <h2 className="text-xl font-semibold text-text-primary">{t("general")}</h2>

      {/* Sunucu İkonu */}
      <AvatarUpload
        currentUrl={server.icon_url}
        fallbackText={server.name}
        onUpload={handleIconUpload}
        isCircle={false}
      />

      {/* Sunucu Adı */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="serverName"
          className="text-sm font-medium text-text-primary"
        >
          {t("serverName")}
        </label>
        <input
          id="serverName"
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          maxLength={100}
          className="w-full max-w-md rounded-md bg-input px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none transition-colors focus:bg-input-focus"
        />
      </div>

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

        {hasChanges && (
          <p className="text-sm text-warning">{t("unsavedChanges")}</p>
        )}
      </div>
    </div>
  );
}

export default ServerGeneralSettings;

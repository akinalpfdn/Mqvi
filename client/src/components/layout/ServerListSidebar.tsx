/**
 * ServerListSidebar — Discord benzeri sol dikey sunucu ikonu listesi.
 *
 * Mevcut Sidebar'ın soluna 56px genişliğinde dar bir dikey bar ekler:
 * ┌────┬──────────┬──────────────────────┬────────┐
 * │ SL │ Channels │ Content Area         │Members │
 * │    │ Sidebar  │                      │        │
 * │ 🌐 │ #genel   │                      │ User1  │
 * │ 🎮 │ #voice   │                      │ User2  │
 * │ ➕ │          │                      │        │
 * └────┴──────────┴──────────────────────┴────────┘
 *  56px   240px         flex-1              240px
 *
 * Her sunucu: yuvarlak ikon (ilk 2 harf fallback)
 * Aktif sunucu: sol tarafta beyaz indicator bar
 * Hover: tooltip ile sunucu adı
 * DM butonu (en üstte, sunucu dışı)
 * "+" butonu (en altta) → AddServerModal
 *
 * CSS class'ları: .server-list-sidebar, .srv-icon-wrap, .srv-icon,
 * .srv-indicator, .srv-tooltip, .srv-separator, .srv-add-icon
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { resolveAssetUrl } from "../../utils/constants";
import AddServerModal from "../servers/AddServerModal";
import type { ServerListItem } from "../../types";

type ServerListSidebarProps = {
  /** Sunucu değiştiğinde çağrılır — cascade refetch tetikler */
  onServerChange: (serverId: string) => void;
};

function ServerListSidebar({ onServerChange }: ServerListSidebarProps) {
  const { t } = useTranslation("servers");
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const setActiveServer = useServerStore((s) => s.setActiveServer);

  const [showAddModal, setShowAddModal] = useState(false);

  function handleServerClick(server: ServerListItem) {
    if (server.id === activeServerId) return;
    setActiveServer(server.id);
    onServerChange(server.id);
  }

  /**
   * Sunucu ikonunun fallback metni — ilk 2 harfi gösterir.
   * Boşlukla ayrılmış kelimelerin baş harfleri: "My Server" → "MS"
   * Tek kelimeyse ilk 2 harf: "Gaming" → "GA"
   */
  function getInitials(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  return (
    <>
      <div className="server-list-sidebar">
        {/* Sunucu listesi */}
        {servers.map((server) => (
          <div
            key={server.id}
            className={`srv-icon-wrap${activeServerId === server.id ? " active" : ""}`}
            onClick={() => handleServerClick(server)}
          >
            <div className="srv-indicator" />
            <div className="srv-icon">
              {server.icon_url ? (
                <img
                  src={resolveAssetUrl(server.icon_url)}
                  alt={server.name}
                />
              ) : (
                <div className="srv-icon-fallback">
                  {getInitials(server.name)}
                </div>
              )}
            </div>
            <span className="srv-tooltip">{server.name}</span>
          </div>
        ))}

        {/* Separator — sunucular ile + butonu arasında */}
        {servers.length > 0 && <div className="srv-separator" />}

        {/* Sunucu ekle butonu */}
        <div
          className="srv-icon-wrap"
          onClick={() => setShowAddModal(true)}
        >
          <div className="srv-add-icon">+</div>
          <span className="srv-tooltip">{t("addServer")}</span>
        </div>
      </div>

      {/* Add Server Modal */}
      {showAddModal && (
        <AddServerModal
          onClose={() => setShowAddModal(false)}
          onServerChange={onServerChange}
        />
      )}
    </>
  );
}

export default ServerListSidebar;

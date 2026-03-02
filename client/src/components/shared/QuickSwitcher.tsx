/**
 * QuickSwitcher — Ctrl+K ile açılan kanal/DM hızlı arama popup'ı.
 *
 * Discord'un Quick Switcher'ına benzer:
 * 1. Ctrl+K ile açılır/kapanır
 * 2. Kullanıcı kanal veya DM adı yazar
 * 3. Sonuçlar filtrelenir, ok tuşları ile navigasyon yapılır
 * 4. Enter ile seçilen kanala/DM'e geçilir
 * 5. Escape ile kapatılır
 *
 * Overlay (backdrop) tıklanınca da kapanır.
 *
 * CSS: .quick-switcher-overlay, .quick-switcher, .qs-* class'ları
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useDMStore } from "../../stores/dmStore";
import type { Channel, DMChannelWithUser } from "../../types";

type SwitcherItem = {
  id: string;
  label: string;
  type: "channel" | "dm";
  /** Kanal tipi ("text" | "voice") veya DM ise undefined */
  channelType?: string;
  /** Kategori adı (kanallar için) */
  category?: string;
};

function QuickSwitcher() {
  const { t } = useTranslation("common");
  const isOpen = useUIStore((s) => s.quickSwitcherOpen);
  const closeQuickSwitcher = useUIStore((s) => s.closeQuickSwitcher);
  const openTab = useUIStore((s) => s.openTab);
  const categories = useChannelStore((s) => s.categories);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const dmChannels = useDMStore((s) => s.channels);
  const selectDM = useDMStore((s) => s.selectDM);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Popup açıldığında input'a focus yap ve state'i sıfırla
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      // requestAnimationFrame: DOM render tamamlanana kadar bekle, sonra focus
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Tüm aranabilir öğeleri tek bir listeye dönüştür
  const allItems = useMemo((): SwitcherItem[] => {
    const channelItems: SwitcherItem[] = categories.flatMap((cg) =>
      cg.channels.map((ch: Channel) => ({
        id: ch.id,
        label: ch.name,
        type: "channel" as const,
        channelType: ch.type,
        category: cg.category.name,
      }))
    );

    const dmItems: SwitcherItem[] = dmChannels.map((dm: DMChannelWithUser) => ({
      id: dm.id,
      label: dm.other_user?.display_name ?? dm.other_user?.username ?? "DM",
      type: "dm" as const,
    }));

    return [...channelItems, ...dmItems];
  }, [categories, dmChannels]);

  // Query'ye göre filtrele
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const lowerQuery = query.toLowerCase();
    return allItems.filter((item) =>
      item.label.toLowerCase().includes(lowerQuery)
    );
  }, [allItems, query]);

  // selectedIndex sınır kontrolü
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  /** Seçilen öğeye git */
  function handleSelect(item: SwitcherItem) {
    if (item.type === "channel") {
      selectChannel(item.id);
      const tabType = item.channelType === "voice" ? "voice" : "text";
      // Multi-server'da tab'a server bilgisi ekle
      let serverInfo: TabServerInfo | undefined;
      if (activeServerId) {
        const srv = servers.find((s) => s.id === activeServerId);
        if (srv) {
          serverInfo = { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
        }
      }
      openTab(item.id, tabType, item.label, serverInfo);
    } else {
      selectDM(item.id);
      openTab(item.id, "dm", item.label);
    }
    closeQuickSwitcher();
  }

  /** Klavye navigasyonu */
  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) {
          handleSelect(filtered[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        closeQuickSwitcher();
        break;
    }
  }

  if (!isOpen) return null;

  return (
    <div className="quick-switcher-overlay" onClick={closeQuickSwitcher}>
      <div className="quick-switcher" onClick={(e) => e.stopPropagation()}>
        {/* Arama input'u */}
        <input
          ref={inputRef}
          className="qs-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("quickSwitcherPlaceholder")}
        />

        {/* Sonuç listesi */}
        <div className="qs-results">
          {filtered.length === 0 ? (
            <div className="qs-empty">{t("noResults")}</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                className={`qs-item${i === selectedIndex ? " qs-selected" : ""}`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="qs-icon">
                  {item.type === "channel" ? (
                    item.channelType === "voice" ? "🔊" : "#"
                  ) : (
                    "@"
                  )}
                </span>
                <span className="qs-label">{item.label}</span>
                {item.category && (
                  <span className="qs-category">{item.category}</span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Alt bilgi — kısayol ipuçları */}
        <div className="qs-footer">
          <span>↑↓ {t("search")}</span>
          <span>↵ {t("confirm")}</span>
          <span>esc {t("close")}</span>
        </div>
      </div>
    </div>
  );
}

export default QuickSwitcher;

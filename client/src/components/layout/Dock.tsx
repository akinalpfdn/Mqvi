/**
 * Dock — macOS-style alt dock, iki katmanlı.
 *
 * CSS class'ları: .dock-area, .dock-container, .dock-svg, .dock-svg-path,
 * .dock-ch-row, .dock-ch-item, .dock-ch-icon, .dock-ch-name, .dock-ch-sep,
 * .dock-srv-row, .dock-item, .dock-srv, .dock-add, .dock-util-icon,
 * .dock-tooltip, .dock-dot, .dock-separator, .dock-profile, .dock-profile-av
 *
 * Hover efektleri CSS ile yönetilir:
 * .dock-item:hover { transform:translateY(-7px) scale(1.14) }
 * .dock-item:hover + .dock-item { transform:translateY(-2px) scale(1.04) }
 * .dock-item:hover .dock-tooltip { opacity:1 }
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useUIStore } from "../../stores/uiStore";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useMemberStore } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import { ChannelSkeleton } from "../shared/Skeleton";
import DMList from "../dm/DMList";
import type { Channel } from "../../types";

type DockProps = {
  onJoinVoice: (channelId: string) => Promise<void>;
};

// ──────────────────────────────────
// SVG Path Builder (referans tasarımdan)
// ──────────────────────────────────

function buildDockPath(
  srvRect: DOMRect | null,
  chRect: DOMRect | null,
  containerRect: DOMRect | null
): string {
  if (!srvRect || !chRect || !containerRect) return "";
  const R = 16;

  const s = {
    l: srvRect.left - containerRect.left,
    r: srvRect.right - containerRect.left,
    t: srvRect.top - containerRect.top,
    b: srvRect.bottom - containerRect.top,
  };
  const c = {
    l: chRect.left - containerRect.left,
    r: chRect.right - containerRect.left,
    t: chRect.top - containerRect.top,
    b: chRect.bottom - containerRect.top,
  };

  const threshold = 2;
  const diffR = s.r - c.r;
  const diffL = c.l - s.l;

  const jrR_raw = Math.abs(diffR);
  const jrL_raw = Math.abs(diffL);
  const jrMax = 14;
  const jrR = Math.min(jrMax, jrR_raw * 0.7);
  const jrL = Math.min(jrMax, jrL_raw * 0.7);

  let d = "";

  d += `M ${c.l + R} ${c.t}`;
  d += ` H ${c.r - R}`;
  d += ` Q ${c.r} ${c.t} ${c.r} ${c.t + R}`;

  if (diffR > threshold) {
    d += ` V ${c.b - jrR}`;
    d += ` Q ${c.r} ${c.b} ${c.r + jrR} ${c.b}`;
    d += ` H ${s.r - R}`;
    d += ` Q ${s.r} ${c.b} ${s.r} ${c.b + R}`;
  } else if (diffR < -threshold) {
    d += ` V ${c.b - R}`;
    d += ` Q ${c.r} ${c.b} ${c.r - R} ${c.b}`;
    d += ` H ${s.r + jrR}`;
    d += ` Q ${s.r} ${c.b} ${s.r} ${c.b + jrR}`;
  } else {
    const maxR = Math.max(c.r, s.r);
    d += ` V ${c.b}`;
    d += ` H ${maxR}`;
  }

  d += ` V ${s.b - R}`;
  d += ` Q ${s.r} ${s.b} ${s.r - R} ${s.b}`;
  d += ` H ${s.l + R}`;
  d += ` Q ${s.l} ${s.b} ${s.l} ${s.b - R}`;

  if (diffL > threshold) {
    d += ` V ${c.b + R}`;
    d += ` Q ${s.l} ${c.b} ${s.l + R} ${c.b}`;
    d += ` H ${c.l - jrL}`;
    d += ` Q ${c.l} ${c.b} ${c.l} ${c.b - jrL}`;
  } else if (diffL < -threshold) {
    d += ` V ${c.b + jrL}`;
    d += ` Q ${s.l} ${c.b} ${s.l - jrL} ${c.b}`;
    d += ` H ${c.l + R}`;
    d += ` Q ${c.l} ${c.b} ${c.l} ${c.b - R}`;
  } else {
    const minL = Math.min(c.l, s.l);
    d += ` V ${c.b}`;
    d += ` H ${minL}`;
  }

  d += ` V ${c.t + R}`;
  d += ` Q ${c.l} ${c.t} ${c.l + R} ${c.t}`;
  d += ` Z`;

  return d;
}

// ──────────────────────────────────
// Dock Component
// ──────────────────────────────────

function Dock({ onJoinVoice }: DockProps) {
  const { t } = useTranslation("common");
  const { t: tCh } = useTranslation("channels");
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const categories = useChannelStore((s) => s.categories);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const openTab = useUIStore((s) => s.openTab);
  const user = useAuthStore((s) => s.user);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const members = useMemberStore((s) => s.members);
  const isChannelsLoading = useChannelStore((s) => s.isLoading);

  // Toplam DM okunmamış sayısı — badge'de gösterilir
  const totalDMUnread = Object.values(dmUnreadCounts).reduce((sum, c) => sum + c, 0);

  // Tüm kanalları flat olarak al
  const allChannels = categories.flatMap((cg) => cg.channels);

  // Text ve voice kanallarını ayır
  const textChannels = allChannels.filter((ch) => ch.type === "text");
  const voiceChannels = allChannels.filter((ch) => ch.type === "voice");

  // DM list popup state
  const [isDMListOpen, setIsDMListOpen] = useState(false);

  // SVG refs
  const containerRef = useRef<HTMLDivElement>(null);
  const srvRowRef = useRef<HTMLDivElement>(null);
  const chRowRef = useRef<HTMLDivElement>(null);
  const [svgPath, setSvgPath] = useState("");
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  // Recalculate SVG path
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!containerRef.current || !srvRowRef.current || !chRowRef.current) return;
        const cRect = containerRef.current.getBoundingClientRect();
        const sRect = srvRowRef.current.getBoundingClientRect();
        const chRect = chRowRef.current.getBoundingClientRect();
        setSvgSize({ w: cRect.width + 4, h: cRect.height + 4 });
        setSvgPath(buildDockPath(sRect, chRect, cRect));
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [allChannels.length]);

  /** Kanal sağ tık context menu */
  const handleChannelContextMenu = useCallback(
    (e: React.MouseEvent, channel: Channel) => {
      const currentMember = members.find((m) => m.id === user?.id);
      const myPerms = currentMember?.effective_permissions ?? 0;
      const canManage = hasPermission(myPerms, Permissions.ManageChannels);

      const items: ContextMenuItem[] = [];

      // Copy Channel Name
      items.push({
        label: "Copy #" + channel.name,
        onClick: () => navigator.clipboard.writeText(channel.name),
      });

      // Edit Channel — ManageChannels yetkisi
      if (canManage) {
        items.push({
          label: tCh("editChannel"),
          onClick: () => {
            openSettings("channels");
          },
          separator: true,
        });
      }

      // Delete Channel — ManageChannels yetkisi
      if (canManage) {
        items.push({
          label: tCh("deleteChannel"),
          onClick: async () => {
            if (window.confirm(tCh("deleteConfirm", { name: channel.name }))) {
              const { deleteChannel } = await import("../../api/channels");
              await deleteChannel(channel.id);
            }
          },
          danger: true,
        });
      }

      openMenu(e, items);
    },
    [members, user, openSettings, openMenu, tCh]
  );

  /** Kanal tıklandığında: tab aç + select */
  const handleChannelClick = useCallback(
    (channel: Channel) => {
      if (channel.type === "voice") {
        onJoinVoice(channel.id);
        selectChannel(channel.id);
        openTab(channel.id, "voice", channel.name);
      } else {
        selectChannel(channel.id);
        openTab(channel.id, "text", channel.name);
      }
    },
    [onJoinVoice, selectChannel, openTab]
  );

  return (
    <div className="dock-area">
      <div className="dock-container" ref={containerRef}>
        {/* SVG merged shape — fill/stroke CSS'te (.dock-svg-path) */}
        <svg
          className="dock-svg"
          width={svgSize.w}
          height={svgSize.h}
          style={{ left: -2, top: -2 }}
        >
          <path d={svgPath} className="dock-svg-path" />
        </svg>

        {/* ─── Channel Row (üst) ─── */}
        <div className="dock-ch-row" ref={chRowRef}>
          {/* Skeleton UI — kanallar yüklenirken gösterilir */}
          {isChannelsLoading && allChannels.length === 0 && (
            <ChannelSkeleton count={4} />
          )}

          {textChannels.map((ch) => {
            const unread = unreadCounts[ch.id] ?? 0;
            return (
              <button
                key={ch.id}
                className={`dock-ch-item${selectedChannelId === ch.id ? " active" : ""}${unread > 0 ? " has-unread" : ""}`}
                onClick={() => handleChannelClick(ch)}
                onContextMenu={(e) => handleChannelContextMenu(e, ch)}
              >
                <span className="dock-ch-icon">#</span>
                <span className="dock-ch-name">{ch.name}</span>
                {unread > 0 && (
                  <span className="dock-unread-badge">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            );
          })}

          {/* Separator */}
          {textChannels.length > 0 && voiceChannels.length > 0 && (
            <div className="dock-ch-sep" />
          )}

          {voiceChannels.map((ch) => (
            <button
              key={ch.id}
              className={`dock-ch-item voice${selectedChannelId === ch.id ? " active" : ""}`}
              onClick={() => handleChannelClick(ch)}
              onContextMenu={(e) => handleChannelContextMenu(e, ch)}
            >
              <span className="dock-ch-icon">{"\uD83D\uDD0A"}</span>
              <span className="dock-ch-name">{ch.name}</span>
            </button>
          ))}
        </div>

        {/* ─── Server Row (alt) ─── */}
        <div className="dock-srv-row" ref={srvRowRef}>
          {/* Server icon — aktif server (şimdilik tek server) */}
          <button className="dock-item dock-srv active">
            <span className="dock-tooltip">{t("server")}</span>
            m
            <span className="dock-dot" />
          </button>

          {/* Add server */}
          <button className="dock-item dock-add">
            <span className="dock-tooltip">{t("addServer")}</span>
            +
          </button>

          <div className="dock-separator" />

          {/* Utility icons */}
          <button className="dock-item" onClick={() => setIsDMListOpen((p) => !p)}>
            <span className="dock-tooltip">{t("messages")}</span>
            <span className="dock-util-icon">{"\uD83D\uDCAC"}</span>
            {totalDMUnread > 0 && (
              <span className="dock-unread-badge dm-badge">
                {totalDMUnread > 99 ? "99+" : totalDMUnread}
              </span>
            )}
          </button>
          <button className="dock-item">
            <span className="dock-tooltip">{t("files")}</span>
            <span className="dock-util-icon">{"\uD83D\uDCC1"}</span>
          </button>
          <button className="dock-item">
            <span className="dock-tooltip">{t("search")}</span>
            <span className="dock-util-icon">{"\uD83D\uDD0D"}</span>
          </button>
          <button className="dock-item" onClick={() => openSettings()}>
            <span className="dock-tooltip">{t("settings")}</span>
            <span className="dock-util-icon">{"\u2699"}</span>
          </button>

          <div className="dock-separator" />

          {/* Profile */}
          <button
            className="dock-item dock-profile"
            title={user?.display_name ?? user?.username ?? "Profile"}
          >
            <div className="dock-profile-av">
              {user?.username?.charAt(0).toUpperCase() ?? "?"}
            </div>
          </button>
        </div>
      </div>

      {/* Context Menu — kanal sağ tık ile açılır */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* DM List popup — Messages butonuna tıklandığında gösterilir */}
      {isDMListOpen && <DMList onClose={() => setIsDMListOpen(false)} />}
    </div>
  );
}

export default Dock;

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
 *
 * ─── Drag & Drop ───
 * Kanal sıralama native Pointer Events API ile yapılır.
 * setPointerCapture ile pointer yakalanır — tüm move/up event'leri
 * yakalayan elemana yönlendirilir. React re-render'dan bağımsız çalışır.
 * Direct DOM manipulation ile her frame'de transform güncellenir (performans).
 * Sadece drag bitişinde React state güncellenir (API çağrısı).
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
import Avatar from "../shared/Avatar";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import * as channelApi from "../../api/channels";
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
// Drag & Drop Types
// ──────────────────────────────────

/**
 * DragInfo — drag sırasında izlenen bilgiler.
 * Ref'te tutulur (useState değil) çünkü:
 * - pointermove her frame'de tetiklenir, setState ile her frame re-render çok pahalı
 * - Direct DOM manipulation ile transform güncellenir (requestAnimationFrame)
 * - Sadece drag başlangıç/bitiş React state günceller
 */
type ItemRect = {
  id: string;
  left: number;
  width: number;
  centerX: number;
};

type DragInfo = {
  channelId: string;
  groupType: "text" | "voice";
  startX: number;
  pointerId: number;
  /** Drag başladığındaki item rect'leri — orijinal konumlar */
  itemRects: ItemRect[];
  /** Drag başladığındaki sıra */
  originalOrder: string[];
  /** Şu anki preview sırası (drag sırasında güncellenir) */
  currentOrder: string[];
  /** Drag aktif mi? (distance threshold geçildi mi?) */
  activated: boolean;
};

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
  const reorderChannels = useChannelStore((s) => s.reorderChannels);
  const isChannelsLoading = useChannelStore((s) => s.isLoading);

  // ─── Permission: ManageChannels yetkisi varsa drag aktif ───
  const currentMember = members.find((m) => m.id === user?.id);
  const myPerms = currentMember?.effective_permissions ?? 0;
  const canManage = hasPermission(myPerms, Permissions.ManageChannels);

  // Toplam DM okunmamış sayısı — badge'de gösterilir
  const totalDMUnread = Object.values(dmUnreadCounts).reduce((sum, c) => sum + c, 0);

  // Tüm kanalları flat olarak al
  const allChannels = categories.flatMap((cg) => cg.channels);

  // Text ve voice kanallarını ayır
  const textChannels = allChannels.filter((ch) => ch.type === "text");
  const voiceChannels = allChannels.filter((ch) => ch.type === "voice");

  // ─── Drag & Drop State ───

  /**
   * dragInfoRef — Drag sırasında tüm bilgileri tutan ref.
   * useState kullanmıyoruz çünkü pointermove her pixel'de tetiklenir.
   * Ref kullanmak re-render'ı önler ve performansı korur.
   */
  const dragInfoRef = useRef<DragInfo | null>(null);

  /**
   * activeDragId — Hangi kanal sürükleniyor?
   * Bu TEK state, drag başladığında set edilir, bittiğinde null olur.
   * Amacı: CSS class'ları (opacity, cursor) için re-render tetiklemek.
   */
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  /**
   * suppressClickRef — Drag sonrası click event'ini engeller.
   * Drag bittiğinde true olur, click handler'da kontrol edilip false yapılır.
   * Böylece sürükleme sonrası kanal seçimi engellenir.
   */
  const suppressClickRef = useRef(false);

  /**
   * itemElsRef — Her kanal butonunun DOM referansı.
   * Drag başladığında getBoundingClientRect() ile pozisyon ölçülür.
   * Drag sırasında style.transform ile direct DOM manipulation yapılır.
   */
  const itemElsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  /**
   * handleChannelPointerDown — Drag potansiyeli başlatır.
   *
   * setPointerCapture: Tüm sonraki pointermove/pointerup event'lerini
   * bu elemana yönlendirir — fare başka elemanların üzerine gitse bile.
   * Bu sayede drag sırasında sibling'lerin event handler'ları tetiklenmez.
   */
  const handleChannelPointerDown = useCallback(
    (e: React.PointerEvent, channel: Channel) => {
      if (!canManage || e.button !== 0) return;

      const group = channel.type === "text" ? textChannels : voiceChannels;

      // Gruptaki tüm item'ların pozisyonlarını ölç
      const rects: ItemRect[] = group.map((ch) => {
        const el = itemElsRef.current.get(ch.id);
        if (!el) return { id: ch.id, left: 0, width: 0, centerX: 0 };
        const r = el.getBoundingClientRect();
        return { id: ch.id, left: r.left, width: r.width, centerX: r.left + r.width / 2 };
      });

      dragInfoRef.current = {
        channelId: channel.id,
        groupType: channel.type as "text" | "voice",
        startX: e.clientX,
        pointerId: e.pointerId,
        itemRects: rects,
        originalOrder: group.map((ch) => ch.id),
        currentOrder: group.map((ch) => ch.id),
        activated: false,
      };

      // Pointer capture: tüm move/up event'leri bu elemana gelir
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [canManage, textChannels, voiceChannels]
  );

  /**
   * handleChannelPointerMove — Drag sırasında her frame çağrılır.
   *
   * İki aşamalı:
   * 1. Distance threshold (8px) geçilmeden: hiçbir şey yapma (tıklama olabilir)
   * 2. Threshold geçildikten sonra: dragged item pointer'ı takip eder,
   *    diğer item'lar yeni sıraya göre kayar (direct DOM manipulation)
   */
  const handleChannelPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.startX;

      // 8px distance threshold — tıklamayı sürüklemeden ayırt eder
      if (!drag.activated && Math.abs(dx) < 8) return;

      // İlk kez threshold geçildi → drag'ı aktive et
      if (!drag.activated) {
        drag.activated = true;
        setActiveDragId(drag.channelId);
      }

      // ─── Yeni sıra hesapla ───
      // Sürüklenen item'ın merkez noktasını pointer offset'e göre hesapla.
      // Bu merkez noktası diğer item'ların merkezleriyle karşılaştırılarak
      // hangi slota düşeceği belirlenir.
      const draggedRect = drag.itemRects.find((r) => r.id === drag.channelId)!;
      const draggedCenter = draggedRect.centerX + dx;

      // Diğer item'ları orijinal sırada tut, dragged item'ı çıkar
      const others = drag.itemRects.filter((r) => r.id !== drag.channelId);

      // Dragged item'ın yeni pozisyonunu bul (center karşılaştırma)
      let insertIdx = others.length; // varsayılan: sona ekle
      for (let i = 0; i < others.length; i++) {
        if (draggedCenter < others[i].centerX) {
          insertIdx = i;
          break;
        }
      }

      // Yeni sıra oluştur
      const newOrder = others.map((r) => r.id);
      newOrder.splice(insertIdx, 0, drag.channelId);
      drag.currentOrder = newOrder;

      // ─── Direct DOM manipulation — transforms uygula ───
      applyDragTransforms(drag, dx);
    },
    []
  );

  /**
   * handleChannelPointerUp — Drag bitişi veya normal tıklama.
   *
   * Drag aktifse: sıra değiştiyse API'ye gönder, inline style'ları temizle.
   * Drag aktif değilse: normal tıklama — suppress etme.
   */
  const handleChannelPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragInfoRef.current;
      if (!drag) return;

      // Pointer capture'ı serbest bırak
      (e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId);

      if (drag.activated) {
        // Tüm inline style'ları temizle
        clearDragStyles(drag);

        // Sıra değiştiyse API'ye gönder
        const orderChanged = !drag.originalOrder.every(
          (id, i) => id === drag.currentOrder[i]
        );
        if (orderChanged) {
          const items = drag.currentOrder.map((id, index) => ({
            id,
            position: index,
          }));
          reorderChannels(items);
        }

        // Drag sonrası click'i engelle
        suppressClickRef.current = true;
      }

      dragInfoRef.current = null;
      setActiveDragId(null);
    },
    [reorderChannels]
  );

  /**
   * handleDragCancel — Pointer cancel veya Escape tuşu ile drag iptal.
   * Tüm inline style'lar temizlenir, sıra değişmez.
   */
  const handleDragCancel = useCallback((e: React.PointerEvent) => {
    const drag = dragInfoRef.current;
    if (!drag) return;

    (e.currentTarget as HTMLElement).releasePointerCapture(drag.pointerId);

    if (drag.activated) {
      clearDragStyles(drag);
    }

    dragInfoRef.current = null;
    setActiveDragId(null);
  }, []);

  // DM list popup state
  const [isDMListOpen, setIsDMListOpen] = useState(false);

  // ─── Channel Create State ───
  const addToast = useToastStore((s) => s.addToast);
  const confirmDialog = useConfirm();
  /** Hangi tür kanal oluşturuluyor? null → popup kapalı */
  const [creatingType, setCreatingType] = useState<"text" | "voice" | null>(null);
  const [createName, setCreateName] = useState("");
  const [isCreatePending, setIsCreatePending] = useState(false);

  async function handleCreateChannel() {
    const trimmed = createName.trim();
    if (!trimmed || isCreatePending || !creatingType) return;

    // Aynı tipteki mevcut bir kanalın category_id'sini bul.
    // Böylece yeni kanal doğru kategoriye (Text Channels / Voice Channels) eklenir.
    // category_id olmadan oluşturulan kanallar GetAllGrouped'da görünmez.
    const existingOfType = allChannels.find((ch) => ch.type === creatingType);
    const categoryId = existingOfType?.category_id ?? undefined;

    setIsCreatePending(true);
    const res = await channelApi.createChannel({
      name: trimmed,
      type: creatingType,
      category_id: categoryId,
    });

    if (res.success) {
      addToast("success", tCh("channelCreated"));
      setCreateName("");
      setCreatingType(null);
    } else {
      addToast("error", tCh("channelCreateError"));
    }
    setIsCreatePending(false);
  }

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
      // Drag sırasında context menu açma
      if (dragInfoRef.current?.activated) {
        e.preventDefault();
        return;
      }

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
            const ok = await confirmDialog({
              message: tCh("deleteConfirm", { name: channel.name }),
              confirmLabel: tCh("deleteChannel"),
              danger: true,
            });
            if (ok) {
              const { deleteChannel } = await import("../../api/channels");
              await deleteChannel(channel.id);
            }
          },
          danger: true,
        });
      }

      openMenu(e, items);
    },
    [canManage, openSettings, openMenu, tCh]
  );

  /** Kanal tıklandığında: tab aç + select */
  const handleChannelClick = useCallback(
    (channel: Channel) => {
      // Drag sonrası click'i engelle
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }

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

  /**
   * renderChannelButton — Bir kanal butonu render eder.
   *
   * Her buton pointer event handler'larına sahiptir:
   * - onPointerDown: drag potansiyeli başlatır + setPointerCapture
   * - onPointerMove: drag sırasında transform günceller (captured)
   * - onPointerUp: drag bitirir veya normal tıklama
   * - onPointerCancel: drag iptal (sistem interrupt)
   */
  function renderChannelButton(ch: Channel, isVoice: boolean) {
    const isActive = selectedChannelId === ch.id;
    const unreadCount = isVoice ? 0 : (unreadCounts[ch.id] ?? 0);
    const isDragging = activeDragId === ch.id;

    return (
      <button
        key={ch.id}
        data-channel-drag-id={ch.id}
        ref={(el) => {
          if (el) itemElsRef.current.set(ch.id, el);
          else itemElsRef.current.delete(ch.id);
        }}
        className={
          `dock-ch-item${isVoice ? " voice" : ""}${isActive ? " active" : ""}` +
          `${unreadCount > 0 ? " has-unread" : ""}${isDragging ? " dragging" : ""}`
        }
        onClick={() => handleChannelClick(ch)}
        onContextMenu={(e) => handleChannelContextMenu(e, ch)}
        onPointerDown={(e) => handleChannelPointerDown(e, ch)}
        onPointerMove={handleChannelPointerMove}
        onPointerUp={handleChannelPointerUp}
        onPointerCancel={handleDragCancel}
      >
        <span className="dock-ch-icon">{isVoice ? "\uD83D\uDD0A" : "#"}</span>
        <span className="dock-ch-name">{ch.name}</span>
        {!isVoice && unreadCount > 0 && (
          <span className="dock-unread-badge">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
    );
  }

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

          {/* Text kanallar */}
          {textChannels.map((ch) => renderChannelButton(ch, false))}

          {/* Text kanal oluştur butonu — ManageChannels yetkisi */}
          {canManage && (
            <button
              className="dock-ch-add"
              onClick={() => {
                setCreatingType("text");
                setCreateName("");
              }}
              title={tCh("createChannel") + " (Text)"}
            >
              +
            </button>
          )}

          {/* Separator */}
          {(textChannels.length > 0 || canManage) && voiceChannels.length > 0 && (
            <div className="dock-ch-sep" />
          )}

          {/* Voice kanallar */}
          {voiceChannels.map((ch) => renderChannelButton(ch, true))}

          {/* Voice kanal oluştur butonu — ManageChannels yetkisi */}
          {canManage && (
            <button
              className="dock-ch-add voice"
              onClick={() => {
                setCreatingType("voice");
                setCreateName("");
              }}
              title={tCh("createChannel") + " (Voice)"}
            >
              +
            </button>
          )}
        </div>

        {/* ─── Server Row (alt) ─── */}
        <div className="dock-srv-row" ref={srvRowRef}>
          {/* Server icon — aktif server (şimdilik tek server) */}
          <button className="dock-item dock-srv active">
            <span className="dock-tooltip">{t("server")}</span>
            <img src="/mqvi-icon.svg" alt="mqvi" className="dock-srv-icon" />
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
            <Avatar
              name={user?.username ?? "?"}
              avatarUrl={user?.avatar_url ?? undefined}
              size={32}
              isCircle
            />
          </button>
        </div>
      </div>

      {/* Channel Create Popover */}
      {creatingType && (
        <div className="dock-create-popover">
          <span className="dock-create-label">
            {creatingType === "text" ? "# " : "\uD83D\uDD0A "}
            {tCh("createChannel")}
          </span>
          <input
            className="dock-create-input"
            placeholder={tCh("channelName")}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateChannel();
              if (e.key === "Escape") setCreatingType(null);
            }}
            autoFocus
            disabled={isCreatePending}
          />
          <div className="dock-create-actions">
            <button
              className="dock-create-btn"
              onClick={handleCreateChannel}
              disabled={!createName.trim() || isCreatePending}
            >
              {isCreatePending ? "..." : tCh("createChannel")}
            </button>
            <button
              className="dock-create-btn secondary"
              onClick={() => setCreatingType(null)}
            >
              {tCh("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Context Menu — kanal sağ tık ile açılır */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* DM List popup — Messages butonuna tıklandığında gösterilir */}
      {isDMListOpen && <DMList onClose={() => setIsDMListOpen(false)} />}
    </div>
  );
}

// ──────────────────────────────────
// Drag Helper Functions
// ──────────────────────────────────

/**
 * applyDragTransforms — Drag sırasında tüm item'lara CSS transform uygular.
 *
 * Direct DOM manipulation kullanılır (el.style.transform) çünkü:
 * - pointermove her frame tetiklenir → setState ile her frame re-render çok pahalı
 * - Direct DOM manipulation O(n) zaman karmaşıklığı ile çalışır (n = item sayısı)
 * - Sadece CSS transform değişir, layout recalculation tetiklenmez (compositing only)
 *
 * Hesaplama:
 * 1. currentOrder'daki sıraya göre her item'ın hedef left pozisyonunu hesapla
 * 2. Hedef pozisyon ile orijinal pozisyon arasındaki farkı translateX olarak uygula
 * 3. Dragged item özel: pointer offset'i ile hareket eder (transition yok)
 * 4. Diğer item'lar: smooth transition ile kayar (200ms ease)
 */
function applyDragTransforms(drag: DragInfo, offsetX: number) {
  // Flex gap: CSS'teki .dock-ch-row gap değeri
  const GAP = 2;

  // currentOrder'a göre hedef pozisyonları hesapla
  let x = drag.itemRects[0]?.left ?? 0;
  const targetLeft = new Map<string, number>();

  for (const id of drag.currentOrder) {
    targetLeft.set(id, x);
    const rect = drag.itemRects.find((r) => r.id === id)!;
    x += rect.width + GAP;
  }

  for (const rect of drag.itemRects) {
    const el = document.querySelector<HTMLElement>(
      `[data-channel-drag-id="${rect.id}"]`
    );
    if (!el) continue;

    if (rect.id === drag.channelId) {
      // Sürüklenen item: pointer'ı takip eder (transition yok, anında)
      el.style.transform = `translateX(${offsetX}px)`;
      el.style.transition = "none";
      el.style.zIndex = "10";
      el.style.opacity = "0.7";
    } else {
      // Diğer item'lar: hedef pozisyona smooth kayar
      const target = targetLeft.get(rect.id)!;
      const shift = target - rect.left;
      el.style.transform = shift !== 0 ? `translateX(${shift}px)` : "";
      el.style.transition = "transform 200ms ease";
      el.style.zIndex = "";
      el.style.opacity = "";
    }
  }
}

/**
 * clearDragStyles — Drag bittiğinde tüm inline style'ları temizler.
 * Bu sayede CSS class'ları tekrar geçerli olur.
 */
function clearDragStyles(drag: DragInfo) {
  for (const rect of drag.itemRects) {
    const el = document.querySelector<HTMLElement>(
      `[data-channel-drag-id="${rect.id}"]`
    );
    if (!el) continue;
    el.style.transform = "";
    el.style.transition = "";
    el.style.zIndex = "";
    el.style.opacity = "";
  }
}

export default Dock;

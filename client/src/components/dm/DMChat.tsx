/**
 * DMChat — DM sohbet görünümü.
 *
 * Artık shared component'lar (MessageList, MessageInput, TypingIndicator)
 * DMChatProvider üzerinden ChatContext ile çalışıyor.
 * Eskiden monolitik bir component'ti — tüm mesaj rendering, input,
 * edit/delete burada inline yapılıyordu.
 *
 * Channel ChatArea ile aynı özellik seti:
 * - Reply (ReplyBar + referenced message preview)
 * - Reactions (EmojiPicker + reaction buttons)
 * - File upload (multipart/form-data)
 * - Pin (pin/unpin + DM pinned messages panel)
 * - Search (DM FTS5 search panel)
 * - Typing indicator
 * - Auto-focus after send (input focus bug fix)
 * - Drag-drop file upload
 *
 * Drag-drop entegrasyonu:
 * DMChatContent, useChatContext() ile addFilesRef'e erişir ve
 * useFileDrop hook'u ile tüm DM alanını drop zone yapar.
 * İki ayrı component gerekir çünkü useChatContext() ancak
 * DMChatProvider'ın child'ı olarak çağrılabilir.
 *
 * CSS class'ları: Server ChatArea'dan miras — .chat-area, .dm-header, vb.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import { useChatContext } from "../../hooks/useChatContext";
import { useConfirm } from "../../hooks/useConfirm";
import { useFileDrop } from "../../hooks/useFileDrop";
import DMChatProvider from "./DMChatProvider";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";
import DMPinnedMessages from "./DMPinnedMessages";
import DMSearchPanel from "./DMSearchPanel";
import FileDropOverlay from "../shared/FileDropOverlay";
import Avatar from "../shared/Avatar";
import * as e2eeApi from "../../api/e2ee";
import type { User } from "../../types";

type DMChatProps = {
  channelId: string;
  sendDMTyping: (dmChannelId: string) => void;
};

/**
 * DMChat — Provider wrapper.
 * DMChatProvider'ı render eder, içeriği DMChatContent'e delege eder.
 */
function DMChat({ channelId, sendDMTyping }: DMChatProps) {
  const channels = useDMStore((s) => s.channels);
  const otherUser = channels.find((ch) => ch.id === channelId)?.other_user;
  const channelName = otherUser?.display_name ?? otherUser?.username ?? "DM";

  return (
    <DMChatProvider
      channelId={channelId}
      channelName={channelName}
      sendDMTyping={sendDMTyping}
    >
      <DMChatContent
        channelId={channelId}
        channelName={channelName}
        otherUser={otherUser ?? null}
      />
    </DMChatProvider>
  );
}

/**
 * DMChatContent — Provider'ın child'ı olarak useChatContext() kullanabilir.
 * Drag-drop file upload burada entegre edilir.
 */
function DMChatContent({
  channelId,
  channelName,
  otherUser,
}: {
  channelId: string;
  channelName: string;
  otherUser: User | null;
}) {
  const { t } = useTranslation("chat");
  const { t: tE2EE } = useTranslation("e2ee");
  const { addFilesRef } = useChatContext();
  const confirm = useConfirm();
  const selectDM = useDMStore((s) => s.selectDM);
  const clearDMUnread = useDMStore((s) => s.clearDMUnread);
  const invalidateMessages = useDMStore((s) => s.invalidateMessages);
  const fetchMessages = useDMStore((s) => s.fetchMessages);
  const toggleE2EE = useDMStore((s) => s.toggleE2EE);
  const e2eeInitStatus = useE2EEStore((s) => s.initStatus);
  const channels = useDMStore((s) => s.channels);
  const dmE2EEEnabled = channels.find((ch) => ch.id === channelId)?.e2ee_enabled ?? false;
  const addToast = useToastStore((s) => s.addToast);

  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [recipientHasKeys, setRecipientHasKeys] = useState(true); // default true — assume ok until checked
  const pendingSearchChannelId = useDMStore((s) => s.pendingSearchChannelId);
  const setPendingSearchChannelId = useDMStore((s) => s.setPendingSearchChannelId);

  // DM tab açıldığında: selectedDMId güncelle + unread sıfırla
  useEffect(() => {
    selectDM(channelId);
    clearDMUnread(channelId);
    return () => {
      selectDM(null);
    };
  }, [channelId, selectDM, clearDMUnread]);

  // E2EE hazir oldugunda mesaj cache'ini temizle ve yeniden fetch et.
  // Race condition: fetchMessages, e2eeStore.initialize() tamamlanmadan once
  // calisirsa localDeviceId null olur → tum mesajlar null content ile cache'lenir.
  // Bu effect, SADECE status "ready"'ye GECIS yaptiginda tetiklenir.
  // Mount aninda zaten "ready" ise MessageList'in kendi fetch'i yeterlidir.
  const prevE2eeStatusRef = useRef(e2eeInitStatus);
  useEffect(() => {
    const prevStatus = prevE2eeStatusRef.current;
    prevE2eeStatusRef.current = e2eeInitStatus;

    // Sadece non-ready → ready gecisinde invalidate + re-fetch
    if (e2eeInitStatus === "ready" && prevStatus !== "ready") {
      invalidateMessages(channelId);
      fetchMessages(channelId);
    }
  }, [e2eeInitStatus, channelId, invalidateMessages, fetchMessages]);

  // Context menu "Mesajlarda Ara" → DM açıldığında search paneli otomatik aç
  useEffect(() => {
    if (pendingSearchChannelId === channelId) {
      setShowSearch(true);
      setPendingSearchChannelId(null);
    }
  }, [pendingSearchChannelId, channelId, setPendingSearchChannelId]);

  // E2EE aktifken alıcının anahtar durumunu kontrol et (banner için)
  useEffect(() => {
    if (!dmE2EEEnabled || !otherUser) {
      setRecipientHasKeys(true);
      return;
    }
    let cancelled = false;
    e2eeApi.listUserDevices(otherUser.id).then((res) => {
      if (cancelled) return;
      setRecipientHasKeys(res.success && !!res.data && res.data.length > 0);
    }).catch(() => {
      if (!cancelled) setRecipientHasKeys(true); // hata durumunda banner gösterme
    });
    return () => { cancelled = true; };
  }, [dmE2EEEnabled, otherUser]);

  /** Pin paneli aç/kapa toggle */
  const handleTogglePins = useCallback(() => {
    setShowPins((prev) => !prev);
  }, []);

  /** Arama paneli aç/kapa toggle */
  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
  }, []);

  // ─── Drag-drop entegrasyonu ───
  const handleFileDrop = useCallback(
    (files: File[]) => {
      addFilesRef.current?.(files);
    },
    [addFilesRef]
  );
  const { isDragging, dragHandlers } = useFileDrop(handleFileDrop);

  return (
    <div className="chat-area" {...dragHandlers}>
      {/* ─── File Drop Overlay ─── */}
      {isDragging && <FileDropOverlay />}

      {/* ─── DM Header ─── */}
      <div className="dm-header">
        <Avatar
          name={channelName}
          avatarUrl={otherUser?.avatar_url ?? undefined}
          size={24}
        />
        <span className="dm-header-name">{channelName}</span>

        {/* Header actions — e2ee, pin, search */}
        <div className="ch-actions">
          {/* E2EE toggle ikonu */}
          <button
            className={dmE2EEEnabled ? "active" : ""}
            onClick={async () => {
              const newState = !dmE2EEEnabled;
              const confirmed = await confirm({
                title: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                message: newState ? tE2EE("enableE2EEConfirmDM") : tE2EE("disableE2EEConfirmDM"),
                confirmLabel: newState ? tE2EE("enableE2EE") : tE2EE("disableE2EE"),
                danger: !newState,
              });
              if (!confirmed) return;
              const ok = await toggleE2EE(channelId, newState);
              if (ok) {
                addToast("success", newState ? tE2EE("e2eeEnabled") : tE2EE("e2eeDisabled"));
              } else {
                addToast("error", tE2EE("e2eeToggleFailed"));
              }
            }}
            title={dmE2EEEnabled ? tE2EE("disableE2EE") : tE2EE("enableE2EE")}
          >
            {dmE2EEEnabled ? (
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            ) : (
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 019.9-1" />
              </svg>
            )}
          </button>
          {/* Pin ikonu */}
          <button
            className={showPins ? "active" : ""}
            onClick={handleTogglePins}
            title={t("pinnedMessages")}
          >
            <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
            </svg>
          </button>
          {/* Arama ikonu */}
          <button
            className={showSearch ? "active" : ""}
            onClick={handleToggleSearch}
            title={t("searchMessages")}
          >
            <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ─── E2EE Recipient No Keys Banner ─── */}
      {dmE2EEEnabled && !recipientHasKeys && (
        <div className="e2ee-warning-banner">
          <svg style={{ width: 16, height: 16, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{tE2EE("recipientNoKeysBanner")}</span>
        </div>
      )}

      {/* ─── DM Pinned Messages Panel ─── */}
      {showPins && (
        <DMPinnedMessages
          channelId={channelId}
          onClose={() => setShowPins(false)}
        />
      )}

      {/* ─── DM Search Panel ─── */}
      {showSearch && (
        <DMSearchPanel
          channelId={channelId}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* ─── Messages Area (shared component) ─── */}
      <MessageList />

      {/* ─── Typing Indicator (shared component) ─── */}
      <TypingIndicator />

      {/* ─── Message Input (shared component) ─── */}
      <MessageInput />
    </div>
  );
}

export default DMChat;

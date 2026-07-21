/** MessageInput — Message compose area. Works in both channel and DM via ChatContext. */

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useChatCommandActions } from "../../hooks/useChatCommandActions";
import { useToastStore } from "../../stores/toastStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import { useNarrowChat } from "../../hooks/useNarrowChat";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useUploadProgress } from "../../hooks/useUploadProgress";
import { validateFiles } from "../../utils/fileValidation";
import { pickNative, supportsNativePicker, type PickKind } from "../../utils/nativePicker";
import { useFileRejectionNotice } from "../../hooks/useFileRejectionNotice";
import { useServerStore, selectServerE2EE } from "../../stores/serverStore";
import { MAX_MESSAGE_LENGTH, MAX_FILE_SIZE, MAX_E2EE_FILE_SIZE } from "../../utils/constants";
import {
  executeChatCommand,
  getCommandQuery,
  hasCommandSuggestion,
  isChatCommand,
  type ChatCommandResult,
} from "../../utils/chatCommands";
import type { MemberWithRoles } from "../../types";
import EmojiPicker from "../shared/EmojiPicker";
import GifPicker from "../shared/GifPicker";
import MobileBottomSheet from "../shared/MobileBottomSheet";
import UploadProgress from "../shared/UploadProgress";
import FilePreview from "./FilePreview";
import MentionAutocomplete, { type MentionSelection } from "./MentionAutocomplete";
import CommandAutocomplete from "./CommandAutocomplete";
import ReplyBar from "./ReplyBar";
import VoiceRecordButton from "./VoiceRecordButton";

type MessageInputProps = {
  openSearch: (query: string) => void;
};

const AUTO_MAX_HEIGHT = 200; // px — auto-grow cap while the input sizes itself to content
const MIN_INPUT_HEIGHT = 40; // px — one line + padding, floor for a manual resize
const MAX_INPUT_HEIGHT = 500; // px — absolute ceiling for a manual resize
const MAX_INPUT_RATIO = 0.5; // and never taller than half the viewport

// CSS field-sizing auto-grows the textarea natively, with none of the per-keystroke
// measure-then-write reflow. Where it isn't supported we fall back to the JS measure.
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content") === true;

function MessageInput({ openSearch }: MessageInputProps) {
  const { t } = useTranslation("chat");
  const { sendPresenceUpdate, toggleMute, toggleDeafen } = useChatCommandActions();
  const {
    mode,
    channelId,
    serverId,
    canSend,
    sendMessage,
    replyingTo,
    setReplyingTo,
    sendTyping,
    addFilesRef,
    members,
  } = useChatContext();
  const addToast = useToastStore((s) => s.addToast);
  const notifyRejected = useFileRejectionNotice();
  // Both selectors return a boolean, so the composer re-renders when encryption flips — not on
  // every unrelated DM-list or server-list update.
  const dmE2EE = useDMStore((s) => s.channels.find((ch) => ch.id === channelId)?.e2ee_enabled ?? false);
  // Same fallback as everywhere else: a tab opened before the server list loaded has no serverId,
  // and defaulting to "not encrypted" would hand an encrypted channel the 100MB cap.
  const activeServerId = useServerStore((s) => s.activeServerId);
  const channelE2EE = useServerStore(selectServerE2EE(serverId ?? activeServerId));
  const isNarrow = useNarrowChat();
  const isTouch = useIsTouch();

  const [content, setContent] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const { progress: uploadProgress, begin: beginUpload, end: endUpload, cancel: cancelUpload } =
    useUploadProgress();

  // Manual resize: null = auto-grow to content (default), a number = user-dragged fixed height.
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startY: number; startHeight: number; max: number; moved: boolean } | null>(null);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const mentionStartRef = useRef<number>(-1);
  const mentionSelectionsRef = useRef<MentionSelection[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Three inputs rather than one whose accept is rewritten before each click: accept is what
  // decides which picker the OS opens, and mutating it imperatively races the click on Android.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);

  // The one place that decides native-vs-web. Mobile picks through the platform so native code gets
  // a path it can open; everywhere else keeps the input elements above.
  function pickFrom(kind: PickKind, ref: React.RefObject<HTMLInputElement | null>) {
    setShowAttachSheet(false);
    if (!supportsNativePicker(kind)) {
      ref.current?.click();
      return;
    }
    pickNative(kind)
      .then(({ files: picked, skipped }) => {
        if (picked.length > 0) acceptFiles(picked.map((entry) => entry.file));
        // A file the platform would not hand over used to vanish with no explanation.
        if (skipped.length > 0) {
          addToast("error", t("attachPickPartial", { name: skipped[0], n: skipped.length }));
        }
      })
      .catch((err) => {
        console.error("[MessageInput] Native picker failed:", err);
        addToast("error", t("attachPickFailed"));
      });
  }

  // Encryption buffers the whole file plus its ciphertext in memory, so an encrypted conversation
  // takes a smaller cap than the transport allows. An unknown server state assumes encrypted: the
  // tighter cap is the safe guess, and the send itself refuses until the state is known.
  const isEncrypted = mode === "dm" ? dmE2EE : mode === "channel" ? (channelE2EE ?? true) : false;
  const attachmentLimit = isEncrypted ? MAX_E2EE_FILE_SIZE : MAX_FILE_SIZE;

  // Every way a file enters the composer — drop zone, paste, picker, camera — funnels through here,
  // so the limit and the rejection notice cannot diverge between entry points.
  const acceptFiles = useCallback(
    (incoming: File[] | FileList) => {
      const { accepted, rejected } = validateFiles(incoming, attachmentLimit);
      notifyRejected(rejected, {
        reason: isEncrypted ? "e2eeSize" : "size",
        maxBytes: attachmentLimit,
      });
      if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    },
    [attachmentLimit, isEncrypted, notifyRejected]
  );

  useEffect(() => {
    addFilesRef.current = acceptFiles;
    return () => {
      addFilesRef.current = null;
    };
  }, [addFilesRef, acceptFiles]);

  useEffect(() => {
    // On touch, auto-focusing on every channel/DM switch yanks the soft keyboard open unprompted.
    // Desktop keeps the convenience; touch waits for the user to tap the composer.
    if (isTouch) return;
    textareaRef.current?.focus();
  }, [channelId, isTouch]);

  useEffect(() => {
    if (replyingTo) {
      textareaRef.current?.focus();
    }
  }, [replyingTo]);

  // Size the textarea: manual drag-height, or auto-grow to content. Runs on content change so
  // it replaces the old per-keystroke reflow that lived inside handleChange.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (manualHeight !== null) {
      // Fixed height wins over the CSS max-height cap so it can exceed the 3-line auto limit.
      ta.style.height = `${manualHeight}px`;
      ta.style.maxHeight = `${manualHeight}px`;
      ta.style.overflowY = "auto";
      return;
    }
    ta.style.maxHeight = "";
    ta.style.overflowY = "";
    if (SUPPORTS_FIELD_SIZING) {
      // Native sizing — clear any inline height and let CSS field-sizing do it, no measure.
      ta.style.height = "auto";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, AUTO_MAX_HEIGHT)}px`;
  }, [content, manualHeight]);

  function convertMentionTokens(text: string): string {
    let result = text;
    const sorted = [...mentionSelectionsRef.current].sort((a, b) => b.name.length - a.name.length);
    for (const m of sorted) {
      const token = m.type === "role" ? `<@&${m.id}>` : `<@${m.id}>`;
      const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(`@${escaped}`, "gi"), token);
    }
    return result;
  }

  function findMemberByTarget(target: string): MemberWithRoles | null {
    const normalized = target.replace(/^@/, "").toLowerCase();
    return members.find((member) => {
      const username = member.username.toLowerCase();
      const displayName = member.display_name?.toLowerCase();
      return username === normalized || displayName === normalized;
    }) ?? null;
  }

  function clearInput(sentContent?: string) {
    // If the user typed something new during the send (e.g. a slow file upload), keep it instead
    // of wiping it — only clear when the box still holds exactly what we sent. Height follows from
    // the content change via the sizing layout effect.
    setContent((current) => (sentContent !== undefined && current !== sentContent ? current : ""));
    setFiles([]);
    setReplyingTo(null);
    setCommandQuery(null);
    mentionSelectionsRef.current = [];
  }

  async function executeCommandAction(commandResult: ChatCommandResult): Promise<boolean> {
    if (!commandResult.ok) {
      addToast("error", t(commandResult.errorKey));
      return false;
    }

    if ("content" in commandResult) {
      return false;
    }

    if (commandResult.action === "status") {
      sendPresenceUpdate(commandResult.status);
      useAuthStore.getState().updateUser({ status: commandResult.status });
      addToast("success", t("statusUpdated", { status: commandResult.status }));
      return true;
    }

    if (commandResult.action === "mute") {
      toggleMute();
      addToast("success", t("muteToggled"));
      return true;
    }

    if (commandResult.action === "deafen") {
      toggleDeafen();
      addToast("success", t("deafenToggled"));
      return true;
    }

    if (commandResult.action === "search") {
      openSearch(commandResult.query);
      return true;
    }

    if (commandResult.action === "help") {
      addToast("info", t("commandHelpText"), 8000);
      return true;
    }

    if (!("target" in commandResult)) {
      return false;
    }

    const member = findMemberByTarget(commandResult.target);
    if (!member) {
      addToast("error", t("commandUserNotFound", { user: commandResult.target }));
      return false;
    }

    const currentUserId = useAuthStore.getState().user?.id;
    if (member.id === currentUserId) {
      addToast("error", t("commandSelfTarget"));
      return false;
    }

    if (commandResult.action === "dm") {
      const dmChannelId = await useDMStore.getState().createOrGetChannel(member.id);
      if (!dmChannelId) {
        addToast("error", t("dmOpenError"));
        return false;
      }

      const label = member.display_name ?? member.username;
      useDMStore.getState().selectDM(dmChannelId);
      useUIStore.getState().openTab(dmChannelId, "dm", label);
      useDMStore.getState().fetchMessages(dmChannelId);
      return true;
    }

    if (commandResult.action === "invite") {
      const currentVoiceChannelId = useVoiceStore.getState().currentVoiceChannelId;
      if (!currentVoiceChannelId) {
        addToast("error", t("inviteNoVoiceChannel"));
        return false;
      }

      const voiceChannel = useChannelStore
        .getState()
        .categories.flatMap((group) => group.channels)
        .find((channel) => channel.id === currentVoiceChannelId);
      if (!voiceChannel) {
        addToast("error", t("inviteNoVoiceChannel"));
        return false;
      }

      const inviteMessage = t("voiceInviteMessage", {
        user: member.username,
        channel: voiceChannel.name,
      });
      const success = await sendMessage(inviteMessage, [], replyingTo?.id);
      if (!success) {
        addToast("error", t("voiceInviteError"));
        return false;
      }

      return true;
    }

    useP2PCallStore.getState().initiateCall(member.id, "voice");
    addToast("success", t("callStarted", { user: member.display_name ?? member.username }));
    return true;
  }

  async function handleSend() {
    if (!channelId) return;
    if (!content.trim() && files.length === 0) return;
    if (isSending) return;

    const commandResult = files.length === 0 ? executeChatCommand(content) : null;
    if (commandResult && !commandResult.ok) {
      addToast("error", t(commandResult.errorKey));
      return;
    }

    if (commandResult?.ok && !("content" in commandResult)) {
      const success = await executeCommandAction(commandResult);
      if (success) {
        clearInput();
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      return;
    }

    const messageContent =
      commandResult?.ok && "content" in commandResult
        ? commandResult.content
        : convertMentionTokens(content.trim());

    setIsSending(true);
    const sentContent = content;
    const replyToId = replyingTo?.id;
    // Only files need a progress/cancel channel; a text-only send is over before a bar could paint.
    const upload = files.length > 0 ? beginUpload() : undefined;
    try {
      const success = await sendMessage(messageContent, files, replyToId, upload);
      // Left intact on failure or cancel, so the same content and files can be re-sent.
      if (success) {
        clearInput(sentContent);
      }
    } finally {
      endUpload();
      setIsSending(false);
    }

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null || hasCommandSuggestion(commandQuery)) {
      if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) {
        return;
      }
    }

    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      setReplyingTo(null);
      return;
    }

    // A soft keyboard offers no Shift+Enter, so on touch Enter inserts a newline and the
    // send button is the only way to submit.
    if (e.key === "Enter" && !e.shiftKey && !isTouch) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setContent(value);
    setCommandQuery(getCommandQuery(value));

    if (channelId && value.length > 0) {
      sendTyping();
    }

    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (!isChatCommand(value) && atIndex >= 0) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      if (charBeforeAt === " " || charBeforeAt === "\n" || atIndex === 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        if (!query.includes("\n")) {
          mentionStartRef.current = atIndex;
          setMentionQuery(query);
        } else {
          setMentionQuery(null);
        }
      } else {
        setMentionQuery(null);
      }
    } else {
      setMentionQuery(null);
    }
  }

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    const ta = textareaRef.current;
    if (!ta) return;
    e.preventDefault();
    const startHeight = ta.getBoundingClientRect().height;
    const max = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, window.innerHeight * MAX_INPUT_RATIO));
    resizeStartRef.current = { startY: e.clientY, startHeight, max, moved: false };
    setIsResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    const delta = start.startY - e.clientY; // drag up → taller
    // Ignore click-jitter: only enter manual mode once it's clearly a drag.
    if (!start.moved && Math.abs(delta) < 3) return;
    start.moved = true;
    setManualHeight(Math.max(MIN_INPUT_HEIGHT, Math.min(start.max, start.startHeight + delta)));
  }

  function handleResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setIsResizing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  function handleMentionSelect(mention: MentionSelection) {
    const start = mentionStartRef.current;
    if (start < 0) return;

    mentionSelectionsRef.current.push(mention);

    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, start);
    const after = content.slice(cursorPos);
    const displayText = `@${mention.name}`;
    const newContent = `${before}${displayText} ${after}`;

    setContent(newContent);
    setMentionQuery(null);
    mentionStartRef.current = -1;

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = start + displayText.length + 1;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  function handleMentionClose() {
    setMentionQuery(null);
    mentionStartRef.current = -1;
  }

  function handleCommandSelect(usage: string) {
    setContent(usage);
    setCommandQuery(null);

    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.selectionStart = usage.length;
      textareaRef.current.selectionEnd = usage.length;
    });
  }

  function handleCommandClose() {
    setCommandQuery(null);
  }

  function handleEmojiSelect(emoji: string) {
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const newContent = content.slice(0, cursorPos) + emoji + content.slice(cursorPos);
    setContent(newContent);
    setShowEmojiPicker(false);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = cursorPos + emoji.length;
        textareaRef.current.selectionStart = pos;
        textareaRef.current.selectionEnd = pos;
        textareaRef.current.focus();
      }
    });
  }

  async function handleGifSelect(url: string) {
    if (!channelId || isSending) return;
    setShowGifPicker(false);
    setIsSending(true);
    const success = await sendMessage(url, [], undefined);
    if (success) {
      clearInput();
    }
    setIsSending(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length > 0) {
      e.preventDefault();
      acceptFiles(pastedFiles);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;

    acceptFiles(e.target.files);
    e.target.value = "";
  }

  function handleFileRemove(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  if (!channelId) return null;

  if (!canSend) {
    return (
      <div className="input-area">
        <div className="input-box input-box-disabled">
          <span className="input-no-perm">{t("noSendPermission")}</span>
        </div>
      </div>
    );
  }

  // No name here — the tab and the header above both already say where this goes, and spelling
  // it out a third time eats most of the input on a phone.
  const placeholder = t("messagePlaceholder");

  /** Mirrors handleSend's guard — the send button must never be live on a no-op. */
  const hasContent = content.trim().length > 0 || files.length > 0;

  return (
    <div className="input-area">
      {mentionQuery !== null && mode === "channel" && (
        <MentionAutocomplete
          query={mentionQuery}
          serverId={serverId}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
        />
      )}

      {commandQuery !== null && (
        <CommandAutocomplete
          query={commandQuery}
          onSelect={handleCommandSelect}
          onClose={handleCommandClose}
        />
      )}

      {replyingTo && (
        <ReplyBar
          message={replyingTo}
          onCancel={() => setReplyingTo(null)}
        />
      )}

      <FilePreview files={files} onRemove={handleFileRemove} />

      {uploadProgress && (
        <UploadProgress
          loaded={uploadProgress.loaded}
          total={uploadProgress.total}
          onCancel={cancelUpload}
        />
      )}

      <div className="input-box">
        <div
          className="input-resize-handle"
          data-dragging={isResizing ? "true" : undefined}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("inputResize")}
          title={t("inputResize")}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => setManualHeight(null)}
        />
        <button
          className="input-action-btn"
          // Touch only. On a mouse there is one system dialog behind all three choices, so the
          // sheet would ask a question whose answers are identical.
          onClick={() => (isTouch ? setShowAttachSheet(true) : fileInputRef.current?.click())}
          title={t("attachFile")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="16" />
            <line x1="8" y1="12" x2="16" y2="12" />
          </svg>
        </button>

        {/* No accept: the documents picker, everything the server's whitelist allows. */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />
        {/* accept is a hint to the OS picker, never a security boundary — the MIME whitelist
            and the size limit are enforced server-side and by validateFiles. */}
        <input
          ref={mediaInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />
        {/* capture opens the camera straight away. Not multiple — a shot is one file. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />

        <MobileBottomSheet isOpen={showAttachSheet} onClose={() => setShowAttachSheet(false)}>
          <div className="mobile-bs-actions-list">
            <button className="mobile-bs-action" onClick={() => pickFrom("camera", cameraInputRef)}>
              <span className="mobile-bs-action-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </span>
              {t("attachCamera")}
            </button>

            <button className="mobile-bs-action" onClick={() => pickFrom("media", mediaInputRef)}>
              <span className="mobile-bs-action-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </span>
              {t("attachGallery")}
            </button>

            <button className="mobile-bs-action" onClick={() => pickFrom("files", fileInputRef)}>
              <span className="mobile-bs-action-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              {t("attachFiles")}
            </button>
          </div>
        </MobileBottomSheet>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
        />

        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn"
            title={t("emoji")}
            onClick={() => {
              setShowGifPicker(false);
              setShowEmojiPicker((prev) => !prev);
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {showEmojiPicker && (
            <div className="input-emoji-picker-wrap">
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
                sheet={isNarrow}
              />
            </div>
          )}
        </div>

        <div style={{ position: "relative" }}>
          <button
            className="input-action-btn input-gif-btn"
            title={t("gif")}
            onClick={() => {
              setShowEmojiPicker(false);
              setShowGifPicker((prev) => !prev);
            }}
          >
            GIF
          </button>
          {showGifPicker && (
            <div className="input-gif-picker-wrap">
              <GifPicker
                onSelect={handleGifSelect}
                onClose={() => setShowGifPicker(false)}
                sheet={isNarrow}
              />
            </div>
          )}
        </div>

        {isTouch && hasContent ? (
          <button
            type="button"
            className="input-action-btn input-send-btn"
            title={t("sendMessage")}
            aria-label={t("sendMessage")}
            disabled={isSending}
            // Keep focus on the textarea so the soft keyboard stays up on send. pointerdown covers
            // touch (mousedown doesn't fire before focus moves on Android), preventing the blur.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void handleSend()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        ) : (
          <VoiceRecordButton
            disabled={isSending}
            onRecorded={(file) => acceptFiles([file])}
          />
        )}
      </div>

      {content.length > MAX_MESSAGE_LENGTH - 100 && (
        <span
          className="char-counter"
          data-warn={content.length > MAX_MESSAGE_LENGTH - 50}
          data-danger={content.length > MAX_MESSAGE_LENGTH - 20}
        >
          {MAX_MESSAGE_LENGTH - content.length}
        </span>
      )}
    </div>
  );
}

export default MessageInput;

/** Message — Renders a single message. Works in both channel and DM via ChatContext. */

import { useState, useMemo, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { formatMessageTime, formatFullDateTime } from "../../utils/dateFormat";
import { useAuthStore } from "../../stores/authStore";
import { useChatContext, type ChatMessage } from "../../hooks/useChatContext";
import { copyToClipboard } from "../../utils/constants";
import { useConfirm } from "../../hooks/useConfirm";
import { useContextMenu } from "../../hooks/useContextMenu";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useLongPress } from "../../hooks/useLongPress";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import Avatar from "../shared/Avatar";
import BadgePill from "../shared/BadgePill";
import ContextMenu from "../shared/ContextMenu";
import InviteCard from "./InviteCard";
import LinkPreviewCard from "./LinkPreviewCard";
import MemberCard from "../members/MemberCard";
import MentionAutocomplete from "./MentionAutocomplete";
import MessageAttachments from "./MessageAttachments";
import MessageHoverActions from "./MessageHoverActions";
import MessageReactions from "./MessageReactions";
import MobileMessageActions from "./MobileMessageActions";
import { useUserBadges } from "../../hooks/useUserBadges";
import { useRoleStore } from "../../stores/roleStore";
import type { MemberWithRoles, User } from "../../types";

type MessageProps = {
  message: ChatMessage;
  /** Consecutive message from same author? (compact mode) */
  isCompact: boolean;
};

/** Returns role type based on member's highest-position role. */
function getRoleType(member: MemberWithRoles | undefined): "admin" | "mod" | null {
  if (!member || member.roles.length === 0) return null;

  const highest = member.roles.reduce((h, r) =>
    r.position > h.position ? r : h
  );

  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

/** Returns color of member's highest-position role. */
function getHighestRoleColor(member: MemberWithRoles | undefined): string | undefined {
  if (!member || member.roles.length === 0) return undefined;

  const highest = member.roles.reduce((h, r) =>
    r.position > h.position ? r : h
  );

  return highest.color || undefined;
}

function Message({ message, isCompact }: MessageProps) {
  const { t, i18n } = useTranslation("chat");
  const currentUser = useAuthStore((s) => s.user);

  // ChatContext — abstracts channel vs DM store differences
  const {
    mode,
    editMessage,
    deleteMessage,
    toggleReaction,
    setReplyingTo,
    setScrollToMessageId,
    pinMessage,
    unpinMessage,
    isMessagePinned,
    canManageMessages,
    showRoleColors,
    members,
  } = useChatContext();

  const roles = useRoleStore((s) => s.roles);
  const isMobile = useIsMobile();
  const confirm = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? "");
  const [editMentionQuery, setEditMentionQuery] = useState<string | null>(null);
  const editMentionStartRef = useRef<number>(-1);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [pickerSource, setPickerSource] = useState<"bar" | "hover" | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<{ user: User; top: number; left: number } | null>(null);

  const isOwner = currentUser?.id === message.user_id;

  // Role info — skipped in DM where showRoleColors=false, members=[]
  const member = showRoleColors ? members.find((m) => m.id === message.user_id) : undefined;
  const roleType = getRoleType(member);
  const roleColor = getHighestRoleColor(member);

  const userBadges = useUserBadges(message.user_id);

  const isPinned = isMessagePinned(message.id);

  // Check if current user is mentioned (user mention or role mention)
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const isMentioned = useMemo(() => {
    if (!currentUser) return false;
    // Direct @user mention
    if (message.mentions?.includes(currentUser.id)) return true;
    // Role mention — check if current user has any of the mentioned roles
    if (message.role_mentions?.length && currentMember?.roles?.length) {
      const myRoleIds = new Set(currentMember.roles.map((r) => r.id));
      return message.role_mentions.some((rid) => myRoleIds.has(rid));
    }
    return false;
  }, [message, currentUser, currentMember]);

  /** Smart timestamp: today->time, yesterday->"Yesterday 22:15", older->date */
  const locale = i18n.language ?? "en";
  const yesterdayLabel = t("yesterday");
  const timeLabels = useMemo(() => ({ yesterday: yesterdayLabel }), [yesterdayLabel]);

  const formatTime = (dateStr: string) =>
    formatMessageTime(dateStr, locale, timeLabels);

  const formatFullDate = (dateStr: string) =>
    formatFullDateTime(dateStr, locale);

  /** Save edit on Enter */
  async function handleEditSave() {
    if (editContent.trim() && editContent.trim() !== message.content) {
      await editMessage(message.id, editContent.trim());
    }
    setIsEditing(false);
  }

  /** Cancel edit on Escape */
  function handleEditCancel() {
    setEditContent(message.content ?? "");
    setEditMentionQuery(null);
    setIsEditing(false);
  }

  /** Detect @mention while editing */
  function handleEditChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setEditContent(value);

    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBeforeAt = atIndex > 0 ? textBeforeCursor[atIndex - 1] : " ";
      if (charBeforeAt === " " || charBeforeAt === "\n" || atIndex === 0) {
        const query = textBeforeCursor.slice(atIndex + 1);
        if (!query.includes(" ") && !query.includes("\n")) {
          editMentionStartRef.current = atIndex;
          setEditMentionQuery(query);
        } else {
          setEditMentionQuery(null);
        }
      } else {
        setEditMentionQuery(null);
      }
    } else {
      setEditMentionQuery(null);
    }
  }

  /** Insert selected mention into edit content */
  function handleEditMentionSelect(username: string) {
    const start = editMentionStartRef.current;
    if (start < 0) return;

    const cursorPos = editTextareaRef.current?.selectionStart ?? editContent.length;
    const before = editContent.slice(0, start);
    const after = editContent.slice(cursorPos);
    const newContent = `${before}@${username} ${after}`;

    setEditContent(newContent);
    setEditMentionQuery(null);
    editMentionStartRef.current = -1;

    requestAnimationFrame(() => {
      if (editTextareaRef.current) {
        const pos = start + username.length + 2;
        editTextareaRef.current.selectionStart = pos;
        editTextareaRef.current.selectionEnd = pos;
        editTextareaRef.current.focus();
      }
    });
  }

  /** Delete with confirmation dialog */
  async function handleDelete() {
    const ok = await confirm({
      message: t("deleteMessageConfirm"),
      confirmLabel: t("deleteMessage"),
      danger: true,
    });
    if (!ok) return;
    await deleteMessage(message.id);
  }

  /** Toggle pin/unpin */
  async function handlePinToggle() {
    if (isPinned) {
      await unpinMessage(message.id);
    } else {
      await pinMessage(message.id);
    }
  }

  /** Opens ReplyBar */
  function handleReply() {
    setReplyingTo(message);
  }

  /** Scroll to referenced message when reply preview is clicked */
  function handleScrollToReply() {
    if (message.reply_to_id) {
      setScrollToMessageId(message.reply_to_id);
    }
  }

  /** Toggle emoji reaction */
  function handleReaction(emoji: string) {
    toggleReaction(message.id, emoji);
  }

  /** Right-click context menu */
  function handleContextMenu(e: React.MouseEvent) {
    const items: ContextMenuItem[] = [];

    // Reply — everyone
    items.push({
      label: t("replyMessage"),
      onClick: handleReply,
    });

    // Add Reaction — everyone
    items.push({
      label: t("addReaction"),
      onClick: () => setPickerSource("bar"),
    });

    // Copy Message — everyone
    items.push({
      label: t("copyMessage"),
      onClick: () => {
        if (message.content) copyToClipboard(message.content);
      },
    });

    // Pin/Unpin — requires ManageMessages
    if (canManageMessages) {
      items.push({
        label: isPinned ? t("unpinMessage") : t("pinMessage"),
        onClick: handlePinToggle,
        separator: true,
      });
    }

    // Edit — owner only
    if (isOwner) {
      items.push({
        label: t("editMessage"),
        onClick: () => {
          setEditContent(message.content ?? "");
          setIsEditing(true);
        },
        separator: !canManageMessages,
      });
    }

    // Delete — owner or ManageMessages
    if (isOwner || canManageMessages) {
      items.push({
        label: t("deleteMessage"),
        onClick: handleDelete,
        danger: true,
      });
    }

    // Copy ID — everyone (debug/power user)
    items.push({
      label: t("copyId"),
      onClick: () => copyToClipboard(message.id),
      separator: true,
    });

    openMenu(e, items);
  }

  // Long-press — opens bottom sheet on mobile instead of context menu
  const longPressHandlers = useLongPress(
    useCallback(() => setMobileActionsOpen(true), []),
    { delay: 500 }
  );

  const displayName =
    message.author?.display_name ?? message.author?.username ?? "Unknown";

  /** Captures @mentions and all http(s) URLs */
  const URL_REGEX = /(@\w+|https?:\/\/[^\s<]+)/gi;

  /** Invite pattern — checked after URL_REGEX match */
  const INVITE_REGEX = /^https?:\/\/[^\s/]+\/invite\/([a-f0-9]{16})$/i;

  /** Klipy GIF pattern */
  const KLIPY_REGEX = /^https?:\/\/static\.klipy\.com\/[^\s]+$/;

  /** Parse message content: @mentions, invite cards, Klipy GIFs, clickable links. */
  function renderContent(text: string | null): React.ReactNode {
    if (!text) return null;

    // Entire message is a single Klipy GIF URL — render as inline image
    const trimmed = text.trim();
    if (KLIPY_REGEX.test(trimmed)) {
      return (
        <a href={trimmed} target="_blank" rel="noopener noreferrer">
          <img src={trimmed} alt="GIF" className="msg-gif-embed" loading="lazy" />
        </a>
      );
    }

    // Build a set of role names (lowercase) for quick lookup
    const roleNameMap = new Map<string, { color: string }>();
    for (const r of roles) {
      roleNameMap.set(r.name.toLowerCase(), { color: r.color });
    }

    const parts = text.split(URL_REGEX);
    return parts.map((part, i) => {
      // @mention — check if it's a role mention or user mention
      if (/^@\w+$/.test(part)) {
        const name = part.slice(1).toLowerCase();
        const roleInfo = roleNameMap.get(name);
        if (roleInfo) {
          return (
            <span
              key={i}
              className="msg-role-mention"
              style={{ color: roleInfo.color, backgroundColor: `${roleInfo.color}20` }}
            >
              {part}
            </span>
          );
        }
        // Resolve display_name from members list
        const mentionedMember = members.find((m) => m.username.toLowerCase() === name);
        const mentionLabel = mentionedMember
          ? `@${mentionedMember.display_name ?? mentionedMember.username}`
          : part;
        return (
          <span key={i} className="msg-mention">
            {mentionLabel}
          </span>
        );
      }
      // Invite link → InviteCard
      const inviteMatch = part.match(INVITE_REGEX);
      if (inviteMatch) {
        return <InviteCard key={i} code={inviteMatch[1]} />;
      }
      // Generic URL — clickable link
      if (/^https?:\/\//i.test(part)) {
        return (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="msg-link">
            {part}
          </a>
        );
      }
      return part;
    });
  }

  /** URLs to show link previews for. Excludes invite/Klipy URLs. Max 5. */
  const previewUrls = useMemo(() => {
    if (!message.content) return [];
    const matches = message.content.match(/https?:\/\/[^\s<]+/gi);
    if (!matches) return [];

    const unique = [...new Set(matches)];
    return unique
      .filter((u) => !INVITE_REGEX.test(u) && !KLIPY_REGEX.test(u))
      .slice(0, 5);
  }, [message.content]);

  const msgClass = `msg${!isCompact ? " first-of-group" : " grouped"}${pickerSource ? " picker-open" : ""}${isMentioned ? " msg-mentioned" : ""}`;

  return (
    <div
      className={msgClass}
      {...(isMobile ? longPressHandlers : {})}
      onContextMenu={isMobile ? longPressHandlers.onContextMenu : handleContextMenu}
    >
      <div className="msg-row">
        <div className="msg-avatar">
          <button
            className="msg-avatar-btn"
            onClick={(e) => {
              if (!message.author) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setProfileTarget({
                user: message.author,
                top: rect.top,
                left: rect.right + 8,
              });
            }}
          >
            <Avatar
              name={displayName}
              role={roleType}
              avatarUrl={message.author?.avatar_url ?? undefined}
              size={30}
            />
          </button>
        </div>

        <div className="msg-body">
          <div className="msg-meta">
            <span
              className="msg-name"
              style={roleColor ? { color: roleColor } : undefined}
            >
              {displayName}
            </span>
            {userBadges.length > 0 && (
              <span className="msg-badges">
                {userBadges.map((ub) =>
                  ub.badge ? <BadgePill key={ub.id} badge={ub.badge} size="sm" /> : null
                )}
              </span>
            )}
            <span
              className="msg-time"
              title={formatFullDate(message.created_at)}
            >
              {formatTime(message.created_at)}
            </span>
          </div>

          {/* Reply preview */}
          {message.reply_to_id && (
            <div className="msg-reply-preview" onClick={handleScrollToReply}>
              <div className="msg-reply-bar" />
              {message.referenced_message?.author ? (
                <>
                  <span className="msg-reply-author">
                    {message.referenced_message.author.display_name ??
                      message.referenced_message.author.username}
                  </span>
                  <span className="msg-reply-content">
                    {message.referenced_message.content ?? t("noContent")}
                  </span>
                </>
              ) : (
                <span className="msg-reply-deleted">{t("replyDeleted")}</span>
              )}
            </div>
          )}

          {/* Pin indicator */}
          {isPinned && (
            <div className="msg-pin-indicator">
              <svg style={{ width: 12, height: 12 }} fill="currentColor" viewBox="0 0 24 24" stroke="none">
                <path d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
              <span>{t("pinnedMessages")}</span>
            </div>
          )}

          {/* Content */}
          {isEditing ? (
            <div className="msg-edit-area">
              {editMentionQuery !== null && mode === "channel" && (
                <MentionAutocomplete
                  query={editMentionQuery}
                  onSelect={handleEditMentionSelect}
                  onClose={() => { setEditMentionQuery(null); editMentionStartRef.current = -1; }}
                />
              )}
              <textarea
                ref={editTextareaRef}
                value={editContent}
                onChange={handleEditChange}
                onKeyDown={(e) => {
                  if (editMentionQuery !== null) {
                    if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleEditSave();
                  }
                  if (e.key === "Escape") handleEditCancel();
                }}
                className="msg-edit-textarea"
                rows={2}
                autoFocus
              />
              <p className="msg-edit-hint">
                escape = {t("editCancel", "cancel")}, enter = {t("editSave", "save")}
              </p>
            </div>
          ) : (
            <div className="msg-text">
              {renderContent(message.content)}
              {previewUrls.length > 0 && (
                <span className="msg-link-previews">
                  {previewUrls.map((url) => (
                    <LinkPreviewCard key={url} url={url} />
                  ))}
                </span>
              )}
              {message.edited_at && (
                <span className="msg-edited">
                  {t("edited")}
                </span>
              )}
              {isCompact && (
                <span className="msg-gtime" title={formatFullDate(message.created_at)}>
                  {formatTime(message.created_at)}
                </span>
              )}
            </div>
          )}

          {/* Attachments */}
          <MessageAttachments message={message} />

          {/* Reactions */}
          <MessageReactions
            message={message}
            pickerSource={pickerSource}
            onPickerOpen={() => setPickerSource("bar")}
            onPickerClose={() => setPickerSource(null)}
            onReaction={handleReaction}
          />
        </div>
      </div>

      {/* Hover actions + Context Menu */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {!isEditing && (
        <MessageHoverActions
          isOwner={isOwner}
          isPinned={isPinned}
          canManageMessages={canManageMessages}
          pickerSource={pickerSource}
          onReply={handleReply}
          onReaction={handleReaction}
          onPickerOpen={() => setPickerSource("hover")}
          onPickerClose={() => setPickerSource(null)}
          onPinToggle={handlePinToggle}
          onEditStart={() => {
            setEditContent(message.content ?? "");
            setIsEditing(true);
          }}
          onDelete={handleDelete}
        />
      )}

      {/* Mobile message actions bottom sheet — opens on long-press */}
      {isMobile && (
        <MobileMessageActions
          isOpen={mobileActionsOpen}
          onClose={() => setMobileActionsOpen(false)}
          message={message}
          onReply={() => {
            handleReply();
            setMobileActionsOpen(false);
          }}
          onPinToggle={handlePinToggle}
          onEdit={() => {
            setEditContent(message.content ?? "");
            setIsEditing(true);
          }}
          onDelete={handleDelete}
          onReaction={handleReaction}
          onCopy={() => {
            if (message.content) copyToClipboard(message.content);
          }}
          canManageMessages={canManageMessages}
          isPinned={isPinned}
        />
      )}

      {profileTarget && (
        <MemberCard
          member={member}
          user={profileTarget.user}
          position={{ top: profileTarget.top, left: profileTarget.left }}
          onClose={() => setProfileTarget(null)}
        />
      )}
    </div>
  );
}

export default Message;

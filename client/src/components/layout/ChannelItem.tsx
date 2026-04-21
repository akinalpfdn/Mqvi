import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { IconSpeaker } from "../shared/Icons";
import type { Channel } from "../../types";

type ChannelItemProps = {
  channel: Channel;
  isActive: boolean;
  unread: number;
  isEffectivelyMuted: boolean;
  isVoiceLocked: boolean;
  voiceDropTarget: boolean;
  canManageChannels: boolean;
  isDragging: boolean;
  dropPos: "above" | "below" | null;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  showRenameEmoji: boolean;
  renameEmojiBtnRef: RefObject<HTMLButtonElement | null>;
  onOpenRenameEmoji: () => void;
  children?: ReactNode;
};

function ChannelItem({
  channel,
  isActive,
  unread,
  isEffectivelyMuted,
  isVoiceLocked,
  voiceDropTarget,
  canManageChannels,
  isDragging,
  dropPos,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  showRenameEmoji,
  renameEmojiBtnRef,
  onOpenRenameEmoji,
  children,
}: ChannelItemProps) {
  const { t: tVoice } = useTranslation("voice");
  const isText = channel.type === "text";
  const mutedClass = isEffectivelyMuted ? " muted" : "";

  return (
    <div
      className={`ch-tree-drag-wrap${isDragging ? " dragging" : ""}${dropPos === "above" ? " drop-above" : ""}${dropPos === "below" ? " drop-below" : ""}`}
      draggable={canManageChannels}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <button
        className={`ch-tree-item${isActive ? " active" : ""}${!isText ? " voice" : ""}${isVoiceLocked ? " locked" : ""}${unread > 0 && !isEffectivelyMuted ? " has-unread" : ""}${voiceDropTarget ? " voice-drop-target" : ""}${mutedClass}`}
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={
          isVoiceLocked
            ? `${channel.name} — ${tVoice("voiceChannelLocked")}`
            : isText
              ? `#${channel.name}`
              : `${channel.name} — ${tVoice("joinVoice")}`
        }
      >
        <span className="ch-tree-icon">
          {isText ? "#" : isVoiceLocked ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/>
            </svg>
          ) : <IconSpeaker width={15} height={15} />}
        </span>
        {isRenaming ? (
          <div className="ch-tree-rename-wrap" onClick={(e) => e.stopPropagation()}>
            <input
              className="ch-tree-inline-rename"
              value={renameValue}
              autoFocus
              onChange={(e) => onRenameChange(e.target.value)}
              maxLength={50}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") onRenameSubmit();
                if (e.key === "Escape") onRenameCancel();
              }}
              onBlur={(e) => {
                if (e.relatedTarget && (e.relatedTarget as HTMLElement).closest(".ch-tree-rename-picker")) return;
                if (!showRenameEmoji) onRenameSubmit();
              }}
            />
            <button
              type="button"
              className="ch-tree-rename-emoji"
              ref={renameEmojiBtnRef}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onOpenRenameEmoji}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </button>
          </div>
        ) : (
          <span className="ch-tree-label">{channel.name}</span>
        )}
        {unread > 0 && !isEffectivelyMuted && (
          <span className="ch-tree-unread-dot" title={`${unread}`} />
        )}
      </button>

      {children}
    </div>
  );
}

export default ChannelItem;

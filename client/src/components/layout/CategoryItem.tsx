import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";

type CategoryItemProps = {
  category: { id: string; name: string };
  isUncategorized: boolean;
  expanded: boolean;
  canManageChannels: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onCreateChannel: () => void;
  catDropClass: string;
  onCatDragStart: (e: React.DragEvent) => void;
  onCatRowDragOver: (e: React.DragEvent) => void;
  onCatDragLeave: () => void;
  onCatRowDrop: (e: React.DragEvent) => void;
  onCatDragEnd: () => void;
  onUncatDragOver: (e: React.DragEvent) => void;
  onUncatDrop: (e: React.DragEvent) => void;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  showRenameEmoji: boolean;
  renameEmojiBtnRef: RefObject<HTMLButtonElement | null>;
  onOpenRenameEmoji: () => void;
  children: ReactNode;
};

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span className={`ch-tree-chevron${expanded ? " expanded" : ""}`}>
      &#x276F;
    </span>
  );
}

function CategoryItem({
  category,
  isUncategorized,
  expanded,
  canManageChannels,
  onToggle,
  onContextMenu,
  onCreateChannel,
  catDropClass,
  onCatDragStart,
  onCatRowDragOver,
  onCatDragLeave,
  onCatRowDrop,
  onCatDragEnd,
  onUncatDragOver,
  onUncatDrop,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  showRenameEmoji,
  renameEmojiBtnRef,
  onOpenRenameEmoji,
  children,
}: CategoryItemProps) {
  const { t: tCh } = useTranslation("channels");

  return (
    <div className="ch-tree-category">
      {isUncategorized ? (
        canManageChannels && (
          <div
            className="ch-tree-uncat-drop"
            onDragOver={onUncatDragOver}
            onDrop={onUncatDrop}
          />
        )
      ) : (
        <div
          className={`ch-tree-cat-row${catDropClass}`}
          draggable={canManageChannels}
          onDragStart={canManageChannels ? onCatDragStart : undefined}
          onDragOver={canManageChannels ? onCatRowDragOver : undefined}
          onDragLeave={canManageChannels ? onCatDragLeave : undefined}
          onDrop={canManageChannels ? onCatRowDrop : undefined}
          onDragEnd={canManageChannels ? onCatDragEnd : undefined}
        >
          <button
            className="ch-tree-cat-header"
            onClick={onToggle}
            onContextMenu={onContextMenu}
          >
            <Chevron expanded={expanded} />
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
              <span>{category.name}</span>
            )}
          </button>
          {canManageChannels && (
            <button
              className="ch-tree-cat-add"
              title={tCh("createChannel")}
              onClick={(e) => {
                e.stopPropagation();
                onCreateChannel();
              }}
            >
              +
            </button>
          )}
        </div>
      )}

      {expanded && children}
    </div>
  );
}

export default CategoryItem;

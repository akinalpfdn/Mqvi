/** MentionAutocomplete — @mention popup with keyboard navigation. Max 5 results. */

import { useState, useEffect, useCallback } from "react";
import { useMemberStore } from "../../stores/memberStore";
import Avatar from "../shared/Avatar";

type MentionAutocompleteProps = {
  /** Search text after @ (e.g. "ali" -> @ali) */
  query: string;
  /** Called when user is selected — returns username */
  onSelect: (username: string) => void;
  /** Close popup (Escape or empty results) */
  onClose: () => void;
};

/** Max visible results */
const MAX_RESULTS = 5;

function MentionAutocomplete({ query, onSelect, onClose }: MentionAutocompleteProps) {
  const members = useMemberStore((s) => s.members);
  const [activeIndex, setActiveIndex] = useState(0);

  // Filter by username or display_name
  const filtered = members
    .filter((m) => {
      const q = query.toLowerCase();
      return (
        m.username.toLowerCase().includes(q) ||
        (m.display_name?.toLowerCase().includes(q) ?? false)
      );
    })
    .slice(0, MAX_RESULTS);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Close when no results
  useEffect(() => {
    if (filtered.length === 0 && query.length > 0) {
      onClose();
    }
  }, [filtered.length, query.length, onClose]);

  /** Keyboard navigation — forwarded from MessageInput */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (filtered.length === 0) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (filtered[activeIndex]) {
            onSelect(filtered[activeIndex].username);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, activeIndex, onSelect, onClose]
  );

  // Global keydown listener (captures events from MessageInput textarea)
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div className="mention-popup">
      {filtered.map((member, index) => (
        <button
          key={member.id}
          className={`mention-item${index === activeIndex ? " active" : ""}`}
          onMouseDown={(e) => {
            // onMouseDown instead of onClick — must fire before blur
            e.preventDefault();
            onSelect(member.username);
          }}
          onMouseEnter={() => setActiveIndex(index)}
        >
          <div className="mention-item-avatar">
            <Avatar
              name={member.display_name ?? member.username}
              avatarUrl={member.avatar_url ?? undefined}
              size={22}
            />
          </div>
          <span className="mention-item-name">
            {member.display_name ?? member.username}
          </span>
          <span className="mention-item-username">
            @{member.username}
          </span>
        </button>
      ))}
    </div>
  );
}

export default MentionAutocomplete;

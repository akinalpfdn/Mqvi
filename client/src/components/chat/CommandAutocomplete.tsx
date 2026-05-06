/**
 * CommandAutocomplete — Slash command suggestion popup.
 *
 * Shown when the user starts typing a "/" command in MessageInput.
 * Inserts the selected command usage template into the textarea.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getCommandOptionContext,
  getCommandOptions,
  getCommandSuggestions,
} from "../../utils/chatCommands";
import { useAuthStore } from "../../stores/authStore";
import { useChatContext } from "../../hooks/useChatContext";

type CommandAutocompleteProps = {
  query: string;
  onSelect: (usage: string) => void;
  onClose: () => void;
};

function CommandAutocomplete({ query, onSelect, onClose }: CommandAutocompleteProps) {
  const { t } = useTranslation("chat");
  const { members } = useChatContext();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const items = useMemo(
    () => {
      const context = getCommandOptionContext(query);
      const memberOptions =
        context.type === "member"
          ? members
              .filter((member) => member.id !== currentUserId)
              .filter((member) => {
                const username = member.username.toLowerCase();
                const displayName = member.display_name?.toLowerCase() ?? "";
                return (
                  username.startsWith(context.query) ||
                  displayName.startsWith(context.query)
                );
              })
              .slice(0, 8)
              .map((member) => {
                const displayName = member.display_name ?? member.username;
                return {
                  id: member.id,
                  name: `@${member.username}`,
                  usage: `/${context.command} @${member.username}`,
                  descriptionKey: "",
                  description: displayName,
                  isOption: true,
                };
              })
          : [];

      return [
        ...memberOptions,
        ...getCommandOptions(query).map((option) => ({
        id: option.value,
        name: option.value,
        usage: option.usage,
        descriptionKey: option.descriptionKey,
        description: "",
        isOption: true,
        })),
        ...getCommandSuggestions(query).map((command) => ({
        id: command.name,
        name: `/${command.name}`,
        usage: command.usage,
        descriptionKey: command.descriptionKey,
        description: "",
        isOption: false,
        })),
      ];
    },
    [query, members, currentUserId]
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (items.length === 0) return;
      const clampedIndex = Math.min(selectedIndex, items.length - 1);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Tab":
        case "Enter":
          e.preventDefault();
          onSelect(items[clampedIndex].usage);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [items, selectedIndex, onSelect, onClose]);

  if (items.length === 0) return null;

  return (
    <div className="command-popup">
      {items.map((item, index) => (
        <button
          key={`${item.isOption ? "option" : "command"}:${item.id}`}
          className={`command-item${index === selectedIndex ? " selected" : ""}`}
          onClick={() => onSelect(item.usage)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className={`command-name${item.isOption ? " command-option-name" : ""}`}>
            {item.name}
          </span>
          <span className="command-copy">
            <span className="command-desc">
              {item.description || t(item.descriptionKey)}
            </span>
            <span className="command-usage">{item.usage}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export default CommandAutocomplete;

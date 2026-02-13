/**
 * MentionAutocomplete — @mention popup component'i.
 *
 * MessageInput'ta kullanıcı "@" yazarken tetiklenir.
 * Üye listesini filtreler ve seçim yapılmasını sağlar.
 *
 * Özellikler:
 * - @ sonrasındaki karakterlere göre gerçek zamanlı filtreleme
 * - Klavye navigasyonu (ArrowUp/Down + Enter/Tab)
 * - Tıklama ile seçim
 * - Max 5 sonuç gösterimi
 *
 * CSS class'ları: .mention-popup, .mention-item, .mention-item.active,
 * .mention-item-avatar, .mention-item-name, .mention-item-username
 */

import { useState, useEffect, useCallback } from "react";
import { useMemberStore } from "../../stores/memberStore";
import Avatar from "../shared/Avatar";

type MentionAutocompleteProps = {
  /** @ sonrasındaki arama metni (ör: "ali" → @ali) */
  query: string;
  /** Kullanıcı seçildiğinde çağrılır — username döner */
  onSelect: (username: string) => void;
  /** Popup kapatma (Escape veya boş sonuç) */
  onClose: () => void;
};

/** Gösterilecek maksimum sonuç sayısı */
const MAX_RESULTS = 5;

function MentionAutocomplete({ query, onSelect, onClose }: MentionAutocompleteProps) {
  const members = useMemberStore((s) => s.members);
  const [activeIndex, setActiveIndex] = useState(0);

  // Filtreleme: username veya display_name ile eşleşenleri al
  const filtered = members
    .filter((m) => {
      const q = query.toLowerCase();
      return (
        m.username.toLowerCase().includes(q) ||
        (m.display_name?.toLowerCase().includes(q) ?? false)
      );
    })
    .slice(0, MAX_RESULTS);

  // Sonuç değiştiğinde aktif index'i sıfırla
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Sonuç yoksa kapat
  useEffect(() => {
    if (filtered.length === 0 && query.length > 0) {
      onClose();
    }
  }, [filtered.length, query.length, onClose]);

  /**
   * handleKeyDown — Klavye navigasyonu.
   * MessageInput'tan forwarded event olarak gelir.
   */
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

  // Global keydown listener (MessageInput'taki textarea'dan gelen eventler)
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
            // onMouseDown kullanıyoruz (onClick yerine) — blur'dan önce tetiklenmeli
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

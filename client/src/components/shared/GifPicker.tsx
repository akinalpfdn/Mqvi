/**
 * GifPicker — Klipy API destekli GIF arama ve seçme component'i.
 *
 * CSS class'ları: .gif-picker, .gif-picker-flipped, .gif-picker-search,
 * .gif-picker-grid, .gif-picker-item, .gif-picker-empty, .gif-picker-loading
 *
 * Tasarım:
 * - Üstte arama input'u, altta GIF grid
 * - Arama yokken trending GIF'ler gösterilir
 * - Arama yazılınca 300ms debounce ile search endpoint çağrılır
 * - Click-outside + ESC ile kapanır (EmojiPicker pattern)
 * - Viewport-aware positioning (üstte sığmazsa aşağı flip)
 *
 * Backend Klipy API proxy kullanır — API key client'a açılmaz.
 * Klipy, Tenor'un halefidir — Discord/WhatsApp dahil geçiş yapıldı.
 * KLIPY_API_KEY yapılandırılmamışsa empty state gösterilir.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trendingGifs, searchGifs, type GifResult } from "../../api/gif";

type GifPickerProps = {
  /** GIF seçildiğinde çağrılır — url parametresi mesaj content'i olacak */
  onSelect: (url: string) => void;
  /** Picker kapatıldığında çağrılır */
  onClose: () => void;
};

function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUnavailable, setIsUnavailable] = useState(false);
  const [flipped, setFlipped] = useState(false);

  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // İlk render'da trending GIF'leri yükle
  useEffect(() => {
    async function loadTrending() {
      setIsLoading(true);
      const res = await trendingGifs(24);
      if (res.success && res.data) {
        setResults(res.data.results);
      } else if (res.error?.includes("not configured") || res.error?.includes("503")) {
        setIsUnavailable(true);
      }
      setIsLoading(false);
    }
    loadTrending();
  }, []);

  // Mount sonrası search input'a focus ve viewport kontrolü
  useEffect(() => {
    searchRef.current?.focus();

    if (pickerRef.current) {
      const rect = pickerRef.current.getBoundingClientRect();
      if (rect.top < 0) {
        setFlipped(true);
      }
    }
  }, []);

  // Click-outside: picker dışına tıklanırsa kapat
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Escape ile kapat
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Debounce temizliği
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** Arama input değişikliği — 300ms debounce ile API çağrısı */
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      if (value.trim()) {
        const res = await searchGifs(value.trim(), 24);
        if (res.success && res.data) {
          setResults(res.data.results);
        }
      } else {
        // Arama temizlendi → trending'e dön
        const res = await trendingGifs(24);
        if (res.success && res.data) {
          setResults(res.data.results);
        }
      }
      setIsLoading(false);
    }, 300);
  }, []);

  /** GIF tıklandığında — URL'i parent'a ilet ve picker'ı kapat */
  function handleGifClick(gif: GifResult) {
    onSelect(gif.url);
    onClose();
  }

  return (
    <div className={`gif-picker${flipped ? " gif-picker-flipped" : ""}`} ref={pickerRef}>
      {/* Arama input'u */}
      <div className="gif-picker-header">
        <input
          ref={searchRef}
          type="text"
          className="gif-picker-search"
          placeholder={t("gifSearch")}
          value={query}
          onChange={handleSearchChange}
        />
      </div>

      {/* İçerik */}
      <div className="gif-picker-body">
        {isUnavailable ? (
          <div className="gif-picker-empty">{t("gifUnavailable")}</div>
        ) : isLoading && results.length === 0 ? (
          <div className="gif-picker-empty">{t("gifLoading")}</div>
        ) : results.length === 0 ? (
          <div className="gif-picker-empty">{t("gifNoResults")}</div>
        ) : (
          <div className="gif-picker-grid">
            {results.map((gif) => (
              <button
                key={gif.id}
                className="gif-picker-item"
                onClick={() => handleGifClick(gif)}
                title={gif.title}
              >
                <img
                  src={gif.preview_url}
                  alt={gif.title}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Klipy attribution — API kullanım şartı gereği */}
      <div className="gif-picker-footer">
        <span className="gif-picker-powered">Powered by KLIPY</span>
      </div>
    </div>
  );
}

export default GifPicker;

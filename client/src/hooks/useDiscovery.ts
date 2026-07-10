import { useEffect, useState } from "react";
import { listPublicServers, type PublicServerListItem } from "../api/discovery";

const DISCOVERY_PAGE_SIZE = 24;
const FEATURED_LIMIT = 12;

/**
 * useDiscovery — data layer for the public server directory. Owns the category/search/page filters
 * and fetches the main list plus a "featured" strip (only on the unfiltered home view). Search is
 * debounced to spare the FTS endpoint.
 */
export function useDiscovery() {
  const [category, setCategory] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<PublicServerListItem[]>([]);
  const [featured, setFeatured] = useState<PublicServerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Debounce the search box → the actual query; reset to page 1 on a new search.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset to page 1 when the category changes.
  useEffect(() => {
    setPage(1);
  }, [category]);

  // Main list. On the unfiltered home view the featured strip already shows featured servers,
  // so exclude them here to avoid showing the same server twice.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const excludeFeatured = !category && !search;
    listPublicServers({ q: search, category, page, limit: DISCOVERY_PAGE_SIZE, excludeFeatured }).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setItems(res.data.items ?? []);
        setTotal(res.data.total);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [search, category, page]);

  // Featured strip — only on the unfiltered home view.
  const showFeatured = !category && !search;
  useEffect(() => {
    if (!showFeatured) {
      setFeatured([]);
      return;
    }
    let cancelled = false;
    listPublicServers({ featured: true, limit: FEATURED_LIMIT }).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setFeatured(res.data.items ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [showFeatured]);

  const totalPages = Math.max(1, Math.ceil(total / DISCOVERY_PAGE_SIZE));

  return {
    category,
    setCategory,
    searchInput,
    setSearchInput,
    page,
    setPage,
    totalPages,
    items,
    featured,
    total,
    loading,
    showFeatured,
  };
}

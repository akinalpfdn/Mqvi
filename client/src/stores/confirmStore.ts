/**
 * Confirm Store — Zustand ile global onay dialogu yönetimi.
 *
 * Neden Zustand store?
 * - window.confirm() yerine uygulama içi özel tasarımlı dialog kullanılır
 * - Promise tabanlı: çağıran kod `await confirm(msg)` ile boolean sonuç alır
 * - Herhangi bir component'ten erişilebilir (getState() ile non-React koddan da)
 *
 * Kullanım:
 *   const confirm = useConfirm();
 *   const ok = await confirm({ title: "...", message: "..." });
 *   if (ok) { ... }
 */

import { create } from "zustand";

type ConfirmOptions = {
  /** Dialog başlığı (opsiyonel — yoksa genel "Onay" başlığı gösterilir) */
  title?: string;
  /** Onay mesajı — kullanıcıya gösterilecek soru */
  message: string;
  /** Onay butonu metni (varsayılan: "Confirm") */
  confirmLabel?: string;
  /** İptal butonu metni (varsayılan: "Cancel") */
  cancelLabel?: string;
  /** Onay butonu tehlikeli mi? (kırmızı renk) */
  danger?: boolean;
};

type ConfirmState = {
  /** Aktif dialog verisi — null ise dialog kapalı */
  options: ConfirmOptions | null;

  /** Promise resolve fonksiyonu — dialog kapanınca çağrılır */
  resolver: ((value: boolean) => void) | null;

  /** Yeni onay dialogu aç — Promise<boolean> döner */
  open: (options: ConfirmOptions) => Promise<boolean>;

  /** Onaylandı — resolver(true) çağır ve kapat */
  confirm: () => void;

  /** İptal edildi — resolver(false) çağır ve kapat */
  cancel: () => void;
};

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  options: null,
  resolver: null,

  open: (options) => {
    return new Promise<boolean>((resolve) => {
      set({ options, resolver: resolve });
    });
  },

  confirm: () => {
    const { resolver } = get();
    if (resolver) resolver(true);
    set({ options: null, resolver: null });
  },

  cancel: () => {
    const { resolver } = get();
    if (resolver) resolver(false);
    set({ options: null, resolver: null });
  },
}));

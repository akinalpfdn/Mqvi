/**
 * Skeleton — Loading placeholder component'leri.
 *
 * Veri yüklenirken gerçek içeriğin yapısını taklit eden gri kutular gösterir.
 * "Shimmer" efekti ile kullanıcıya içeriğin yüklenmekte olduğunu bildirir.
 *
 * Skeleton pattern nedir?
 * Spinner yerine içeriğin şeklini gösteren placeholder'lar kullanmak.
 * Kullanıcı neyin yükleneceğini önceden görebildiği için
 * bekleme süresi daha kısa hissedilir (perceived performance).
 *
 * Kullanım:
 * <MessageSkeleton count={5} />
 * <MemberSkeleton count={8} />
 * <ChannelSkeleton count={4} />
 *
 * CSS: .sk-* class'ları (globals.css)
 */

/** Mesaj listesi skeleton — avatar + isim + metin satırları */
export function MessageSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="sk-container">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-message">
          <div className="sk-avatar" />
          <div className="sk-body">
            <div className="sk-line sk-short" />
            <div className="sk-line sk-long" />
            {i % 2 === 0 && <div className="sk-line sk-medium" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Üye listesi skeleton — küçük avatar + isim */
export function MemberSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="sk-container">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-member">
          <div className="sk-avatar-sm" />
          <div className="sk-line sk-name" />
        </div>
      ))}
    </div>
  );
}

/** Kanal listesi skeleton — # ikon + isim pill */
export function ChannelSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-channel">
          <div className="sk-ch-icon" />
          <div className="sk-line sk-ch-name" />
        </div>
      ))}
    </>
  );
}

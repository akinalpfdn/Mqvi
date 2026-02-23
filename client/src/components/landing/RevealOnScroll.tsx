/**
 * RevealOnScroll — IntersectionObserver ile scroll reveal animasyonu.
 *
 * Kullanım: Sarmaladığı içeriğe scroll edildiğinde fade-up animasyonu uygular.
 *
 * Nasıl çalışır?
 * IntersectionObserver, bir DOM elementinin viewport'a girip girmediğini izler.
 * Element %15 görünür olduğunda "visible" state'e geçer ve CSS class toggle yapılır.
 * Bir kez görünür olunca observer disconnect edilir (tekrar gizlenmez).
 *
 * CSS class'ları: .lp-reveal → .lp-reveal--visible (landing.css'de tanımlı)
 *
 * @param delay — transition-delay saniye cinsinden (ör: 0.1, 0.2)
 */

import { useRef, useState, useEffect, type ReactNode } from "react";

type RevealOnScrollProps = {
  children: ReactNode;
  /** Animasyon gecikme süresi (saniye) — sıralı kartlar için kullanışlı */
  delay?: number;
};

function RevealOnScroll({ children, delay = 0 }: RevealOnScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`lp-reveal${isVisible ? " lp-reveal--visible" : ""}`}
      style={delay > 0 ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </div>
  );
}

export default RevealOnScroll;

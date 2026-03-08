/**
 * RevealOnScroll — Fade-up animation triggered by IntersectionObserver.
 * Fires once at 15% visibility, then disconnects.
 */

import { useRef, useState, useEffect, type ReactNode } from "react";

type RevealOnScrollProps = {
  children: ReactNode;
  /** Transition delay in seconds for staggered reveals */
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

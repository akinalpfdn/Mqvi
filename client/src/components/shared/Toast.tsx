/**
 * Toast — Tek bir toast notification bileşeni.
 *
 * Görünüm:
 * ┌──────────────────────────────────┐
 * │ [ikon]  Mesaj metni         [X]  │
 * └──────────────────────────────────┘
 *
 * Sol kenar: type'a göre renkli border (border-l-4)
 * - success → border-success (yeşil)
 * - error   → border-danger (kırmızı)
 * - warning → border-warning (sarı)
 * - info    → border-info (mavi)
 *
 * Animasyon:
 * - Enter: sağdan kayarak gelir (translate-x-0)
 * - Exit: sağa kayarak + fade-out (translate-x-full + opacity-0)
 */

import { useCallback } from "react";

type ToastProps = {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  isExiting: boolean;
  onDismiss: (id: string) => void;
};

/** Type → sol kenar rengi mapping */
const borderColorMap = {
  success: "border-l-success",
  error: "border-l-danger",
  warning: "border-l-warning",
  info: "border-l-info",
} as const;

function Toast({ id, type, message, isExiting, onDismiss }: ToastProps) {
  const handleDismiss = useCallback(() => {
    onDismiss(id);
  }, [id, onDismiss]);

  return (
    <div
      className={`flex w-toast-width items-start gap-3 rounded-md border-l-4 bg-background-floating px-4 py-3 shadow-lg transition-all duration-300 ${
        borderColorMap[type]
      } ${
        isExiting
          ? "translate-x-full opacity-0"
          : "translate-x-0 opacity-100"
      }`}
      role="alert"
    >
      {/* Type ikonu */}
      <div className="mt-0.5 shrink-0">
        <ToastIcon type={type} />
      </div>

      {/* Mesaj */}
      <p className="min-w-0 flex-1 text-sm text-text-primary">{message}</p>

      {/* Kapat butonu */}
      <button
        onClick={handleDismiss}
        className="shrink-0 text-text-muted transition-colors hover:text-text-primary"
        aria-label="Close"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

/**
 * ToastIcon — Type'a göre ikon render eder.
 *
 * Success: Checkmark circle
 * Error: X circle
 * Warning: Exclamation triangle
 * Info: Info circle
 */
function ToastIcon({ type }: { type: ToastProps["type"] }) {
  const colorMap = {
    success: "text-success",
    error: "text-danger",
    warning: "text-warning",
    info: "text-info",
  } as const;

  const className = `h-5 w-5 ${colorMap[type]}`;

  switch (type) {
    case "success":
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "error":
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "warning":
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      );
    case "info":
      return (
        <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
        </svg>
      );
  }
}

export default Toast;

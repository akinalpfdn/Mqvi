/**
 * ErrorBoundary — React render crash'lerini yakalar ve otomatik kurtarır.
 *
 * React'ta render sırasında yakalanmayan hata tüm component tree'yi öldürür.
 * Electron'da browser gibi F5/refresh yok — kullanıcı siyah ekranla kalır.
 *
 * Bu component:
 * 1. componentDidCatch ile render hatalarını yakalar
 * 2. Kısa bir süre bekledikten sonra window.location.reload() ile sayfayı yeniler
 * 3. Kullanıcıya "Bir hata oluştu, yeniden yükleniyor..." mesajı gösterir
 *
 * React ErrorBoundary class component olmak ZORUNDA — hook'larla yazılamaz.
 * Bu, React'ın bilinen bir kısıtlamasıdır (getDerivedStateFromError + componentDidCatch
 * sadece class component lifecycle'da mevcuttur).
 */

import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

class ErrorBoundary extends Component<Props, State> {
  private reloadTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, errorInfo);

    // 2 saniye sonra otomatik reload — kullanıcıya mesaj göstermeye yetecek kadar
    this.reloadTimerId = setTimeout(() => {
      window.location.reload();
    }, 2000);
  }

  componentWillUnmount() {
    if (this.reloadTimerId) {
      clearTimeout(this.reloadTimerId);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            backgroundColor: "var(--color-background)",
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: "15px",
          }}
        >
          Reloading...
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

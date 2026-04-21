/**
 * ErrorBoundary — Catches render crashes and auto-reloads after 2s.
 * Must be a class component (React limitation for error boundaries).
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

    // Auto-reload after 2s
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

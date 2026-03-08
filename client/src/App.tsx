import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./components/auth/LoginPage";
import RegisterPage from "./components/auth/RegisterPage";
import ForgotPasswordPage from "./components/auth/ForgotPasswordPage";
import ResetPasswordPage from "./components/auth/ResetPasswordPage";
import AppLayout from "./components/layout/AppLayout";
import LandingPage from "./components/landing/LandingPage";
import InviteJoinPage from "./components/servers/InviteJoinPage";
import UpdateNotification from "./components/shared/UpdateNotification";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { isElectron } from "./utils/constants";

/**
 * App — Root component. Handles routing and auth initialization.
 * Shows loading spinner until auth state is resolved, then routes
 * to /channels (authenticated) or /login (unauthenticated).
 */
function App() {
  const { t } = useTranslation("common");
  const initialize = useAuthStore((s) => s.initialize);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const user = useAuthStore((s) => s.user);
  const updater = useUpdateChecker();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (!isInitialized) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-6 h-14 w-14 animate-spin rounded-full border-4 border-surface border-t-brand" />
          <p className="text-base text-text-muted">{t("loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Auto-update banner */}
      {(updater.status === "downloading" ||
        updater.status === "ready" ||
        updater.status === "error") && (
        <UpdateNotification
          status={updater.status}
          version={updater.update?.version ?? ""}
          progress={updater.progress}
          error={updater.error}
          onRestart={updater.restartAndInstall}
          onDismiss={updater.dismiss}
        />
      )}
    <Routes>
      {/* Landing — Electron skips to login directly */}
      <Route
        path="/"
        element={
          user ? (
            <Navigate to="/channels" replace />
          ) : isElectron() ? (
            <Navigate to="/login" replace />
          ) : (
            <LandingPage />
          )
        }
      />

      {/* Auth pages — unauthenticated only */}
      <Route
        path="/login"
        element={user ? <Navigate to="/channels" replace /> : <LoginPage />}
      />
      <Route
        path="/register"
        element={user ? <Navigate to="/channels" replace /> : <RegisterPage />}
      />
      <Route
        path="/forgot-password"
        element={user ? <Navigate to="/channels" replace /> : <ForgotPasswordPage />}
      />
      <Route
        path="/reset-password"
        element={user ? <Navigate to="/channels" replace /> : <ResetPasswordPage />}
      />

      {/* Invite join — auth check is handled inside InviteJoinPage */}
      <Route path="/invite/:code" element={<InviteJoinPage />} />

      {/* Main app — authenticated only */}
      <Route
        path="/channels/*"
        element={user ? <AppLayout /> : <Navigate to="/login" replace />}
      />

      {/* Default redirect — unknown routes */}
      <Route
        path="*"
        element={
          <Navigate to={user ? "/channels" : isElectron() ? "/login" : "/"} replace />
        }
      />
    </Routes>
    </>
  );
}

export default App;

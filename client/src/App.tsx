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
 * App — Root component. Routing ve auth initialization burada.
 *
 * Akış:
 * 1. Uygulama açılınca → authStore.initialize() çağrılır
 * 2. Token varsa → /api/users/me ile kullanıcı çekilir
 * 3. isInitialized true olana kadar loading spinner gösterilir
 * 4. User varsa → /channels, yoksa → /login
 *
 * i18n: "common" namespace'ini kullanır (loading metni gibi genel string'ler).
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
      {/* Auto-update banner — indirme sırasında progress, bitince restart butonu */}
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
      {/* Landing — giriş yapmamış kullanıcılar tanıtım sayfası görür.
          Electron desktop'ta onboarding gereksiz → direkt login'e yönlendir. */}
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

      {/* Auth sayfaları — sadece giriş yapmamış kullanıcılar */}
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

      {/* Davet katılma sayfası — dış paylaşımlardan gelen linkler.
          Auth kontrolü InviteJoinPage içinde yapılır (returnUrl ile login'e yönlendirir). */}
      <Route path="/invite/:code" element={<InviteJoinPage />} />

      {/* Ana uygulama — sadece giriş yapmış kullanıcılar */}
      <Route
        path="/channels/*"
        element={user ? <AppLayout /> : <Navigate to="/login" replace />}
      />

      {/* Varsayılan yönlendirme — bilinmeyen rotalar */}
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

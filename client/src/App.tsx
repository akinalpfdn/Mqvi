import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import LoginPage from "./components/auth/LoginPage";
import RegisterPage from "./components/auth/RegisterPage";
import AppLayout from "./components/layout/AppLayout";
import LandingPage from "./components/landing/LandingPage";

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

  // useEffect: Component mount olduğunda (ilk render) çalışır.
  // [] dependency array boş = sadece bir kez çalışır (componentDidMount gibi).
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Henüz auth kontrolü yapılmadıysa → loading göster
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
    <Routes>
      {/* Landing — giriş yapmamış kullanıcılar tanıtım sayfası görür */}
      <Route
        path="/"
        element={user ? <Navigate to="/channels" replace /> : <LandingPage />}
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

      {/* Ana uygulama — sadece giriş yapmış kullanıcılar */}
      <Route
        path="/channels/*"
        element={user ? <AppLayout /> : <Navigate to="/login" replace />}
      />

      {/* Varsayılan yönlendirme — bilinmeyen rotalar landing'e */}
      <Route
        path="*"
        element={
          <Navigate to={user ? "/channels" : "/"} replace />
        }
      />
    </Routes>
  );
}

export default App;

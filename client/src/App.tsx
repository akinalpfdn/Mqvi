import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import { useSettingsStore } from "./stores/settingsStore";
import LoginPage from "./components/auth/LoginPage";
import RegisterPage from "./components/auth/RegisterPage";
import ForgotPasswordPage from "./components/auth/ForgotPasswordPage";
import ResetPasswordPage from "./components/auth/ResetPasswordPage";
import AppLayout from "./components/layout/AppLayout";
import LandingPage from "./components/landing/LandingPage";
import PrivacyPage from "./components/landing/PrivacyPage";
import TermsPage from "./components/landing/TermsPage";
import DeleteAccountPage from "./components/landing/DeleteAccountPage";
import InviteJoinPage from "./components/servers/InviteJoinPage";
import UpdateNotification from "./components/shared/UpdateNotification";
import CustomTitleBar from "./components/layout/CustomTitleBar";
import FileViewerOverlay from "./components/viewers/FileViewerOverlay";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { useDeepLinks } from "./hooks/useDeepLinks";
import { isElectron, isNativeApp, publicAsset } from "./utils/constants";

/**
 * App — Root component. Handles routing and auth initialization.
 * Shows loading spinner until auth state is resolved, then routes
 * to /channels (authenticated) or /login (unauthenticated).
 */
function App() {
  const initialize = useAuthStore((s) => s.initialize);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const user = useAuthStore((s) => s.user);
  const updater = useUpdateChecker();
  const blurEnabled = useSettingsStore((s) => s.blurEnabled);
  const transparentBackground = useSettingsStore((s) => s.transparentBackground);

  // Safe to fire before auth resolves: no route renders until isInitialized, so an invite link
  // opened while logged out lands on /invite and is bounced to login with its returnUrl intact.
  useDeepLinks();

  useEffect(() => {
    initialize();
  }, [initialize]);

  // Apply blur + transparent classes at root level so they also affect
  // pre-auth pages (login, register, landing).
  useEffect(() => {
    document.body.classList.toggle("blur-enabled", blurEnabled);
    document.body.classList.toggle("blur-disabled", !blurEnabled);
  }, [blurEnabled]);

  useEffect(() => {
    document.documentElement.classList.toggle("transparent-bg", transparentBackground);
    document.body.classList.toggle("transparent-bg", transparentBackground);
  }, [transparentBackground]);

  if (!isInitialized) {
    // Mirrors #app-loader in index.html so React mounting over it is invisible.
    const spinner = (
      <div className="app-loading">
        <img src={publicAsset("mqvi-icon-128.png")} alt="" className="app-loading-logo" />
        <div className="app-loading-spinner" />
      </div>
    );

    if (isElectron()) {
      return (
        <div className="electron-app-wrapper">
          <CustomTitleBar />
          {spinner}
        </div>
      );
    }

    return spinner;
  }

  const updateBanner =
    (updater.status === "downloading" || updater.status === "ready") ? (
      <UpdateNotification
        status={updater.status}
        version={updater.update?.version ?? ""}
        progress={updater.progress}
        onRestart={updater.restartAndInstall}
        onDismiss={updater.dismiss}
      />
    ) : null;

  const routes = (
    <Routes>
      {/* Landing — native apps (Electron/Capacitor) skip to login directly */}
      <Route
        path="/"
        element={
          user ? (
            <Navigate to="/channels" replace />
          ) : isNativeApp() ? (
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

      {/* Legal pages — public */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/policies" element={<Navigate to="/privacy" replace />} />
      <Route path="/delete-account" element={<DeleteAccountPage />} />

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
          <Navigate to={user ? "/channels" : isNativeApp() ? "/login" : "/"} replace />
        }
      />
    </Routes>
  );

  if (isElectron()) {
    return (
      <div className="electron-app-wrapper">
        <CustomTitleBar />
        {updateBanner}
        {routes}
        <FileViewerOverlay />
      </div>
    );
  }

  return (
    <>
      {routes}
      <FileViewerOverlay />
    </>
  );
}

export default App;

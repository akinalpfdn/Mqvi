/** SecuritySettings — Email change/remove (with password verification), password change,
 *  deleted servers list, and self-account-delete. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import * as authApi from "../../api/auth";
import * as serversApi from "../../api/servers";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_BYTES, passwordByteLength } from "../../utils/constants";
import { passwordErrorKey } from "../../utils/passwordError";
import type { DeletedServerInfo } from "../../api/servers";

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function daysUntil(iso: string): number {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
  } catch {
    return 0;
  }
}

function SecuritySettings() {
  const { t, i18n } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const replaceTokens = useAuthStore((s) => s.replaceTokens);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  // ─── Deleted Servers State ───
  const [deletedServers, setDeletedServers] = useState<DeletedServerInfo[]>([]);
  const [isLoadingDeleted, setIsLoadingDeleted] = useState(true);
  const [actioningServer, setActioningServer] = useState<string | null>(null);

  // ─── Delete Account State ───
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await serversApi.getDeletedServers();
      if (cancelled) return;
      if (res.success && res.data) {
        setDeletedServers(res.data);
      }
      setIsLoadingDeleted(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Email State ───
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [isEmailSaving, setIsEmailSaving] = useState(false);

  // ─── Password State ───
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // ─── Email Handlers ───
  const canSubmitEmail = emailPassword.length > 0 && !isEmailSaving;

  async function handleEmailSubmit() {
    if (!canSubmitEmail) return;

    // Client-side: empty = remove, otherwise validate format
    const trimmedEmail = newEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      addToast("error", t("emailInvalid"));
      return;
    }

    setIsEmailSaving(true);
    try {
      const res = await authApi.changeEmail(emailPassword, trimmedEmail);
      if (res.success) {
        const resultEmail = res.data?.email ?? null;
        updateUser({ email: resultEmail });
        addToast("success", trimmedEmail ? t("emailChanged") : t("emailRemoved"));
        setNewEmail("");
        setEmailPassword("");
      } else {
        const errMsg = res.error ?? "";
        if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("already in use") || errMsg.includes("already exists")) {
          addToast("error", t("emailAlreadyExists"));
        } else if (errMsg.includes("invalid email")) {
          addToast("error", t("emailInvalid"));
        } else if (errMsg.includes("same as current")) {
          addToast("error", t("emailSameAsCurrent"));
        } else {
          addToast("error", t("emailChangeError"));
        }
      }
    } finally {
      setIsEmailSaving(false);
    }
  }

  // ─── Password Handlers ───
  const canSubmitPassword =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !isSaving;

  async function handlePasswordSubmit() {
    if (!canSubmitPassword) return;

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      addToast("error", t("passwordTooShort"));
      return;
    }

    if (passwordByteLength(newPassword) > PASSWORD_MAX_BYTES) {
      addToast("error", t("passwordTooLong"));
      return;
    }

    if (newPassword !== confirmPassword) {
      addToast("error", t("passwordMismatch"));
      return;
    }

    if (currentPassword === newPassword) {
      addToast("error", t("passwordSameAsOld"));
      return;
    }

    setIsSaving(true);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      if (res.success && res.data) {
        replaceTokens(res.data.access_token, res.data.refresh_token, res.data.file_token);
        addToast("success", t("passwordChanged"));
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        // Password rejections carry a code; the rest are still matched on English text.
        const passwordKey = passwordErrorKey(res.code);
        const errMsg = res.error ?? "";
        if (passwordKey) {
          addToast("error", i18n.t(passwordKey));
        } else if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("different")) {
          addToast("error", t("passwordSameAsOld"));
        } else {
          addToast("error", t("passwordChangeError"));
        }
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("security")}</h2>

      {/* ═══ Email Section ═══ */}
      <h3 className="settings-section-subtitle">{t("emailSection")}</h3>

      {/* Current email display */}
      <div className="settings-field">
        <label className="settings-label">{t("currentEmail")}</label>
        <p className="settings-value">
          {user?.email ?? t("noEmail")}
        </p>
      </div>

      {/* New email */}
      <div className="settings-field">
        <label htmlFor="newEmail" className="settings-label">
          {t("newEmail")}
        </label>
        <input
          id="newEmail"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* Password verification */}
      <div className="settings-field">
        <label htmlFor="emailPassword" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="emailPassword"
          type="password"
          value={emailPassword}
          onChange={(e) => setEmailPassword(e.target.value)}
          placeholder={t("emailPasswordPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <p className="settings-hint">{t("emailPasswordRequired")}</p>
      </div>

      {/* Email actions */}
      <div className="settings-btn-row">
        <button
          onClick={handleEmailSubmit}
          disabled={!canSubmitEmail || !newEmail.trim()}
          className="settings-btn"
        >
          {isEmailSaving ? t("changeEmail") + "..." : t("changeEmail")}
        </button>
        {user?.email && (
          <button
            onClick={() => {
              setNewEmail("");
              handleEmailSubmit();
            }}
            disabled={!canSubmitEmail}
            className="settings-btn settings-btn-danger"
          >
            {t("removeEmail")}
          </button>
        )}
      </div>

      {/* ═══ Separator ═══ */}
      <div className="settings-divider" />

      {/* ═══ Password Section ═══ */}
      <h3 className="settings-section-subtitle">{t("changePassword")}</h3>

      {/* Current Password */}
      <div className="settings-field">
        <label htmlFor="currentPassword" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder={t("currentPasswordPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* New Password */}
      <div className="settings-field">
        <label htmlFor="newPassword" className="settings-label">
          {t("newPassword")}
        </label>
        <input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("newPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Confirm New Password */}
      <div className="settings-field">
        <label htmlFor="confirmNewPassword" className="settings-label">
          {t("confirmNewPassword")}
        </label>
        <input
          id="confirmNewPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder={t("confirmNewPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Submit */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={handlePasswordSubmit}
          disabled={!canSubmitPassword}
          className="settings-btn"
        >
          {isSaving ? t("changePassword") + "..." : t("changePassword")}
        </button>
      </div>

      {/* ═══ Separator ═══ */}
      <div className="settings-divider" />

      {/* ═══ Deleted Servers Section ═══ */}
      <h3 className="settings-section-subtitle">{t("deletedServers")}</h3>
      <p className="settings-hint">{t("deletedServersDescription")}</p>

      {isLoadingDeleted ? (
        <p className="settings-value">…</p>
      ) : deletedServers.length === 0 ? (
        <p className="settings-value">{t("deletedServersEmpty")}</p>
      ) : (
        <ul className="deleted-server-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {deletedServers.map((srv) => {
            const remaining = daysUntil(srv.permanent_delete_at);
            const isAdminDeleted = srv.deleted_by_admin;
            const busy = actioningServer === srv.id;
            return (
              <li
                key={srv.id}
                className="settings-field"
                style={{ display: "flex", alignItems: "center", gap: 12 }}
              >
                {srv.icon_url ? (
                  <img
                    src={srv.icon_url}
                    alt=""
                    style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover" }}
                  />
                ) : (
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "var(--color-background-tertiary)",
                    }}
                    aria-hidden
                  >
                    {srv.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{srv.name}</div>
                  <div className="settings-hint" style={{ marginTop: 2 }}>
                    {isAdminDeleted ? (
                      <span>{t("deletedByAdminLabel")} · {formatDate(srv.deleted_at, i18n.language)}</span>
                    ) : (
                      <span>
                        {t("permanentDeleteIn", { days: remaining })} · {formatDate(srv.deleted_at, i18n.language)}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {!isAdminDeleted && (
                    <button
                      className="settings-btn"
                      disabled={busy}
                      onClick={async () => {
                        setActioningServer(srv.id);
                        const res = await serversApi.restoreServer(srv.id);
                        setActioningServer(null);
                        if (res.success) {
                          setDeletedServers((prev) => prev.filter((s) => s.id !== srv.id));
                          addToast("success", t("restoreServerSuccess"));
                        } else {
                          addToast("error", res.error ?? t("restoreServerFailed"));
                        }
                      }}
                    >
                      {t("restore")}
                    </button>
                  )}
                  {isAdminDeleted && (
                    <span
                      className="settings-hint"
                      style={{ alignSelf: "center", maxWidth: 240, textAlign: "right" }}
                    >
                      {t("deletedByAdminCannotRestore")}
                    </span>
                  )}
                  <button
                    className="settings-btn settings-btn-danger"
                    disabled={busy || isAdminDeleted}
                    onClick={async () => {
                      if (!window.confirm(t("permanentDeleteServerConfirm", { name: srv.name }))) return;
                      setActioningServer(srv.id);
                      const res = await serversApi.hardDeleteServer(srv.id);
                      setActioningServer(null);
                      if (res.success) {
                        setDeletedServers((prev) => prev.filter((s) => s.id !== srv.id));
                        addToast("success", t("permanentDeleteServerSuccess"));
                      } else {
                        addToast("error", res.error ?? t("permanentDeleteServerFailed"));
                      }
                    }}
                  >
                    {t("permanentDelete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ═══ Separator ═══ */}
      <div className="settings-divider" />

      {/* ═══ Delete Account Section ═══ */}
      <h3 className="settings-section-subtitle">{t("deleteAccountSection")}</h3>
      <p className="settings-hint">{t("deleteAccountDescription")}</p>

      {!confirmingDelete ? (
        <div style={{ marginTop: 16 }}>
          <button
            className="settings-btn settings-btn-danger"
            onClick={() => setConfirmingDelete(true)}
          >
            {t("deleteAccount")}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <p className="settings-value" style={{ marginBottom: 12 }}>
            {t("deleteAccountConfirmBody")}
          </p>
          <div className="settings-field">
            <label htmlFor="deleteAccountPassword" className="settings-label">
              {t("deleteAccountPasswordLabel")}
            </label>
            <input
              id="deleteAccountPassword"
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="settings-input"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
            />
          </div>
          <div className="settings-btn-row">
            <button
              className="settings-btn"
              onClick={() => {
                setConfirmingDelete(false);
                setDeletePassword("");
              }}
              disabled={isDeletingAccount}
            >
              {t("cancel", { ns: "common", defaultValue: "Cancel" })}
            </button>
            <button
              className="settings-btn settings-btn-danger"
              disabled={isDeletingAccount || deletePassword.length === 0}
              onClick={async () => {
                setIsDeletingAccount(true);
                const res = await authApi.softDeleteSelf(deletePassword);
                setIsDeletingAccount(false);
                if (res.success) {
                  addToast("success", t("deleteAccountSuccess"));
                  await logout();
                  navigate("/login");
                } else {
                  addToast("error", res.error ?? t("deleteAccountFailed"));
                }
              }}
            >
              {t("deleteAccountConfirm")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SecuritySettings;

/**
 * AddServerModal — Sunucu oluşturma veya katılma modal'ı.
 *
 * 3 görünüm modunda çalışır:
 * 1. **choice**: Oluştur veya Katıl seçimi
 * 2. **create**: Çok adımlı sunucu oluşturma wizard'ı
 *    - Step 1: Sunucu adı
 *    - Step 2: Host tipi (mqvi hosted / self-hosted)
 *    - Step 3: LiveKit config (sadece self-hosted)
 * 3. **join**: Davet kodu ile katılma
 *
 * CSS class'ları: .add-server-overlay, .add-server-modal, .add-server-header,
 * .add-server-body, .add-server-steps, .host-type-card, .add-server-choice-btn
 *
 * i18n: "servers" namespace'ini kullanır.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import type { CreateServerRequest } from "../../types";

type AddServerModalProps = {
  onClose: () => void;
};

type View = "choice" | "create" | "join";
type HostType = "mqvi_hosted" | "self_hosted";

function AddServerModal({ onClose }: AddServerModalProps) {
  const { t } = useTranslation("servers");
  const { t: tCommon } = useTranslation("common");
  const createServer = useServerStore((s) => s.createServer);
  const joinServer = useServerStore((s) => s.joinServer);
  const addToast = useToastStore((s) => s.addToast);

  // ─── State ───
  const [view, setView] = useState<View>("choice");

  // Create wizard state
  const [createStep, setCreateStep] = useState(1);
  const [serverName, setServerName] = useState("");
  const [hostType, setHostType] = useState<HostType>("mqvi_hosted");
  const [livekitUrl, setLivekitUrl] = useState("");
  const [livekitKey, setLivekitKey] = useState("");
  const [livekitSecret, setLivekitSecret] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Join state
  const [inviteCode, setInviteCode] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const inviteInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on view change
  useEffect(() => {
    if (view === "create" && createStep === 1) {
      nameInputRef.current?.focus();
    } else if (view === "join") {
      inviteInputRef.current?.focus();
    }
  }, [view, createStep]);

  // Overlay'a tıklayınca kapat (modal dışı)
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }

  // ESC tuşu ile kapat
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ─── Create Handlers ───

  /** Toplam step sayısı — self-hosted ise 3, aksi halde 2 */
  const totalCreateSteps = hostType === "self_hosted" ? 3 : 2;

  function handleCreateNext() {
    if (createStep === 1 && !serverName.trim()) return;
    if (createStep < totalCreateSteps) {
      setCreateStep(createStep + 1);
    } else {
      handleCreateSubmit();
    }
  }

  function handleCreateBack() {
    if (createStep > 1) {
      setCreateStep(createStep - 1);
    } else {
      setView("choice");
    }
  }

  async function handleCreateSubmit() {
    if (isCreating) return;
    setIsCreating(true);

    const req: CreateServerRequest = {
      name: serverName.trim(),
      host_type: hostType,
    };

    if (hostType === "self_hosted") {
      req.livekit_url = livekitUrl.trim();
      req.livekit_key = livekitKey.trim();
      req.livekit_secret = livekitSecret.trim();
    }

    const server = await createServer(req);
    setIsCreating(false);

    if (server) {
      addToast("success", t("serverCreated"));
      // createServer zaten activeServerId + activeServer'ı atomik olarak set eder.
      // AppLayout useEffect activeServerId değişimini algılayıp cascadeRefetch yapar.
      onClose();
    } else {
      addToast("error", tCommon("somethingWentWrong"));
    }
  }

  // ─── Join Handlers ───

  async function handleJoinSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (isJoining || !inviteCode.trim()) return;

    setIsJoining(true);
    setJoinError(null);

    const server = await joinServer(inviteCode.trim());
    setIsJoining(false);

    if (server) {
      addToast("success", t("serverJoined"));
      // joinServer zaten activeServerId + activeServer'ı atomik olarak set eder.
      onClose();
    } else {
      setJoinError(t("invalidInviteCode"));
    }
  }

  // ─── Create wizard validation ───

  function isCreateStepValid(): boolean {
    if (createStep === 1) return serverName.trim().length > 0;
    if (createStep === 2) return true; // host type always has a selection
    if (createStep === 3) {
      return (
        livekitUrl.trim().length > 0 &&
        livekitKey.trim().length > 0 &&
        livekitSecret.trim().length > 0
      );
    }
    return false;
  }

  /** Step indicator'da step'in durumunu belirler */
  function stepClass(step: number): string {
    if (step < createStep) return "add-server-step done";
    if (step === createStep) return "add-server-step active";
    return "add-server-step";
  }

  // ─── Render ───

  return (
    <div className="add-server-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="add-server-modal">
        {/* Header */}
        <div className="add-server-header">
          <h2 className="add-server-title">
            {view === "choice" && t("addServer")}
            {view === "create" && t("createServer")}
            {view === "join" && t("joinServer")}
          </h2>
          <button className="add-server-close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        <div className="add-server-body">
          {/* ═══ Choice View ═══ */}
          {view === "choice" && (
            <div className="add-server-choice">
              {/* Sunucu Oluştur */}
              <button
                className="add-server-choice-btn"
                onClick={() => setView("create")}
              >
                <div className="add-server-choice-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                </div>
                <div className="add-server-choice-text">
                  <div className="add-server-choice-title">{t("createServer")}</div>
                  <div className="add-server-choice-desc">{t("addServerDesc")}</div>
                </div>
                <span className="add-server-choice-arrow">&#x276F;</span>
              </button>

              {/* Or separator */}
              <div className="add-server-or">{t("orSeparator")}</div>

              {/* Sunucuya Katıl */}
              <button
                className="add-server-choice-btn"
                onClick={() => setView("join")}
              >
                <div className="add-server-choice-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                </div>
                <div className="add-server-choice-text">
                  <div className="add-server-choice-title">{t("joinServer")}</div>
                  <div className="add-server-choice-desc">{t("inviteCodePlaceholder")}</div>
                </div>
                <span className="add-server-choice-arrow">&#x276F;</span>
              </button>
            </div>
          )}

          {/* ═══ Create Wizard ═══ */}
          {view === "create" && (
            <>
              {/* Step indicator */}
              <div className="add-server-steps">
                {Array.from({ length: totalCreateSteps }, (_, i) => (
                  <div key={i} className={stepClass(i + 1)} />
                ))}
              </div>

              {/* Step 1: Sunucu adı */}
              {createStep === 1 && (
                <div className="add-server-field">
                  <label className="add-server-label">{t("serverName")}</label>
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder={t("serverNamePlaceholder")}
                    maxLength={100}
                    className="add-server-input"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateNext();
                    }}
                  />
                </div>
              )}

              {/* Step 2: Host tipi */}
              {createStep === 2 && (
                <div className="host-type-cards">
                  <div
                    className={`host-type-card${hostType === "mqvi_hosted" ? " selected" : ""}`}
                    onClick={() => setHostType("mqvi_hosted")}
                  >
                    <div className="host-type-radio">
                      <div className="host-type-radio-dot" />
                    </div>
                    <div className="host-type-info">
                      <div className="host-type-name">{t("mqviHosted")}</div>
                      <div className="host-type-desc">{t("mqviHostedDesc")}</div>
                    </div>
                  </div>

                  <div
                    className={`host-type-card${hostType === "self_hosted" ? " selected" : ""}`}
                    onClick={() => setHostType("self_hosted")}
                  >
                    <div className="host-type-radio">
                      <div className="host-type-radio-dot" />
                    </div>
                    <div className="host-type-info">
                      <div className="host-type-name">{t("selfHosted")}</div>
                      <div className="host-type-desc">{t("selfHostedDesc")}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 3: LiveKit config (self-hosted only) */}
              {createStep === 3 && hostType === "self_hosted" && (
                <>
                  <div className="add-server-field">
                    <label className="add-server-label">{t("livekitUrl")}</label>
                    <input
                      type="text"
                      value={livekitUrl}
                      onChange={(e) => setLivekitUrl(e.target.value)}
                      placeholder={t("livekitUrlPlaceholder")}
                      className="add-server-input"
                    />
                  </div>
                  <div className="add-server-field">
                    <label className="add-server-label">{t("livekitKey")}</label>
                    <input
                      type="text"
                      value={livekitKey}
                      onChange={(e) => setLivekitKey(e.target.value)}
                      placeholder={t("livekitKeyPlaceholder")}
                      className="add-server-input"
                    />
                  </div>
                  <div className="add-server-field">
                    <label className="add-server-label">{t("livekitSecret")}</label>
                    <input
                      type="password"
                      value={livekitSecret}
                      onChange={(e) => setLivekitSecret(e.target.value)}
                      placeholder={t("livekitSecretPlaceholder")}
                      className="add-server-input"
                    />
                  </div>
                </>
              )}

              {/* Action butonları */}
              <div className="add-server-actions">
                <button
                  className="add-server-btn-secondary"
                  onClick={handleCreateBack}
                >
                  {tCommon("back")}
                </button>
                <button
                  className="add-server-btn-primary"
                  onClick={handleCreateNext}
                  disabled={!isCreateStepValid() || isCreating}
                >
                  {createStep === totalCreateSteps
                    ? isCreating
                      ? t("creating")
                      : t("createButton")
                    : tCommon("next")}
                </button>
              </div>
            </>
          )}

          {/* ═══ Join View ═══ */}
          {view === "join" && (
            <form onSubmit={handleJoinSubmit}>
              <div className="add-server-field">
                <label className="add-server-label">{t("inviteCode")}</label>
                <input
                  ref={inviteInputRef}
                  type="text"
                  value={inviteCode}
                  onChange={(e) => {
                    setInviteCode(e.target.value);
                    if (joinError) setJoinError(null);
                  }}
                  placeholder={t("inviteCodePlaceholder")}
                  maxLength={32}
                  className="add-server-input"
                />
                {joinError && (
                  <p style={{ color: "var(--red)", fontSize: 13, marginTop: 6 }}>
                    {joinError}
                  </p>
                )}
              </div>

              <div className="add-server-actions">
                <button
                  type="button"
                  className="add-server-btn-secondary"
                  onClick={() => {
                    setView("choice");
                    setJoinError(null);
                  }}
                >
                  {tCommon("back")}
                </button>
                <button
                  type="submit"
                  className="add-server-btn-primary"
                  disabled={!inviteCode.trim() || isJoining}
                >
                  {isJoining ? t("joining") : t("joinButton")}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default AddServerModal;

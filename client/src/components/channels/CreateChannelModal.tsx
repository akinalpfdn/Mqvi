/**
 * CreateChannelModal — Create channel or category.
 * Step 1: Name, mode, type, category. Step 2 (channel only): permission overrides.
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import * as channelApi from "../../api/channels";
import ChannelPermissionEditor from "../settings/ChannelPermissionEditor";
import EmojiPicker from "../shared/EmojiPicker";
import type { Channel } from "../../types";

type CreateChannelModalProps = {
  onClose: () => void;
  /** Pre-select mode when opened from category "+" button */
  defaultMode?: "category" | "channel";
  /** Pre-select parent category when opened from category "+" button */
  defaultCategoryId?: string;
};

function CreateChannelModal({
  onClose,
  defaultMode,
  defaultCategoryId,
}: CreateChannelModalProps) {
  const { t } = useTranslation("channels");
  const { t: tCommon } = useTranslation("common");
  const categories = useChannelStore((s) => s.categories);
  const addToast = useToastStore((s) => s.addToast);

  // ─── State ───
  const [mode, setMode] = useState<"category" | "channel">(
    defaultMode ?? "channel"
  );
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [categoryId, setCategoryId] = useState(defaultCategoryId ?? "");
  const [createdChannel, setCreatedChannel] = useState<Channel | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Category = 1 step, channel = 2 steps
  const totalSteps = mode === "channel" ? 2 : 1;

  // Auto-focus name input
  useEffect(() => {
    if (step === 1) {
      nameInputRef.current?.focus();
    }
  }, [step]);

  // Close on overlay click
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // ─── Handlers ───

  async function handleNext() {
    const trimmed = name.trim();
    if (!trimmed || isCreating) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setIsCreating(true);

    if (mode === "category") {
      // Create category and close
      const res = await channelApi.createCategory(serverId, { name: trimmed });
      setIsCreating(false);
      if (res.success) {
        addToast("success", t("categoryCreated"));
        onClose();
      } else {
        addToast("error", t("categoryCreateError"));
      }
    } else {
      // Create channel and go to step 2
      const res = await channelApi.createChannel(serverId, {
        name: trimmed,
        type: channelType,
        category_id: categoryId || undefined,
      });
      setIsCreating(false);
      if (res.success && res.data) {
        addToast("success", t("channelCreated"));
        setCreatedChannel(res.data);
        setStep(2);
      } else {
        addToast("error", t("channelCreateError"));
      }
    }
  }

  function handleBack() {
    if (step > 1) {
      setStep(step - 1);
    }
  }

  function isStepValid(): boolean {
    if (step === 1) return name.trim().length > 0;
    return true;
  }

  function stepClass(s: number): string {
    if (s < step) return "add-server-step done";
    if (s === step) return "add-server-step active";
    return "add-server-step";
  }

  // ─── Render ───

  return createPortal(
    <div
      className="add-server-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
    >
      <div className="add-server-modal">
        {/* Header */}
        <div className="add-server-header">
          <h2 className="add-server-title">
            {step === 1
              ? t("createChannelOrCategory")
              : t("channelPermissions")}
          </h2>
          <button className="add-server-close" onClick={onClose}>
            &#x2715;
          </button>
        </div>

        <div className="add-server-body">
          {/* Step indicator — only shown for channel mode (2 steps) */}
          {mode === "channel" && (
            <div className="add-server-steps">
              {Array.from({ length: totalSteps }, (_, i) => (
                <div key={i} className={stepClass(i + 1)} />
              ))}
            </div>
          )}

          {/* ═══ Step 1: Name + Mode + Type + Category ═══ */}
          {step === 1 && (
            <>
              {/* Mode: Channel / Category */}
              <div className="host-type-cards">
                <div
                  className={`host-type-card${mode === "channel" ? " selected" : ""}`}
                  onClick={() => setMode("channel")}
                >
                  <div className="host-type-radio">
                    <div className="host-type-radio-dot" />
                  </div>
                  <div className="host-type-info">
                    <div className="host-type-name">{t("channel")}</div>
                    <div className="host-type-desc">{t("channelDesc")}</div>
                  </div>
                </div>

                <div
                  className={`host-type-card${mode === "category" ? " selected" : ""}`}
                  onClick={() => setMode("category")}
                >
                  <div className="host-type-radio">
                    <div className="host-type-radio-dot" />
                  </div>
                  <div className="host-type-info">
                    <div className="host-type-name">{t("category")}</div>
                    <div className="host-type-desc">{t("categoryDesc")}</div>
                  </div>
                </div>
              </div>

              {/* Name */}
              <div className="add-server-field" style={{ marginTop: 16 }}>
                <label className="add-server-label">
                  {mode === "category" ? t("categoryName") : t("channelName")}
                </label>
                <div className="name-input-with-emoji">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={
                      mode === "category" ? t("categoryName") : t("channelName")
                    }
                    maxLength={50}
                    className="add-server-input"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleNext();
                    }}
                  />
                  <button
                    type="button"
                    className="name-emoji-btn"
                    onClick={() => setShowEmojiPicker((p) => !p)}
                    title={t("emoji", { ns: "chat" })}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      <line x1="9" y1="9" x2="9.01" y2="9" />
                      <line x1="15" y1="9" x2="15.01" y2="9" />
                    </svg>
                  </button>
                  {showEmojiPicker && (
                    <div className="name-emoji-picker-wrap">
                      <EmojiPicker
                        onSelect={(emoji) => {
                          setName((prev) => {
                            const next = prev + emoji;
                            return [...next].length <= 50 ? next : prev;
                          });
                          setShowEmojiPicker(false);
                          nameInputRef.current?.focus();
                        }}
                        onClose={() => setShowEmojiPicker(false)}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Channel-specific fields */}
              {mode === "channel" && (
                <>
                  {/* Channel Type: Text / Voice */}
                  <div className="add-server-field">
                    <label className="add-server-label">
                      {t("channelTypeLabel")}
                    </label>
                    <div className="create-ch-type-row">
                      <div
                        className={`create-ch-type-option${channelType === "text" ? " selected" : ""}`}
                        onClick={() => setChannelType("text")}
                      >
                        <div className="create-ch-type-radio">
                          <div className="create-ch-type-radio-dot" />
                        </div>
                        <span className="create-ch-type-icon">#</span>
                        <span className="create-ch-type-label">
                          {t("text")}
                        </span>
                      </div>
                      <div
                        className={`create-ch-type-option${channelType === "voice" ? " selected" : ""}`}
                        onClick={() => setChannelType("voice")}
                      >
                        <div className="create-ch-type-radio">
                          <div className="create-ch-type-radio-dot" />
                        </div>
                        <span className="create-ch-type-icon">
                          {"\uD83D\uDD0A"}
                        </span>
                        <span className="create-ch-type-label">
                          {t("voice")}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Category selection */}
                  <div className="add-server-field">
                    <label className="add-server-label">
                      {t("selectCategory")}
                    </label>
                    <select
                      className="create-ch-select"
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                    >
                      <option value="">{t("channelNoCategory")}</option>
                      {categories
                        .filter((cg) => cg.category.id !== "")
                        .map((cg) => (
                          <option key={cg.category.id} value={cg.category.id}>
                            {cg.category.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </>
              )}

              <div className="add-server-actions">
                <button
                  className="add-server-btn-secondary"
                  onClick={onClose}
                >
                  {tCommon("cancel")}
                </button>
                <button
                  className="add-server-btn-primary"
                  onClick={handleNext}
                  disabled={!isStepValid() || isCreating}
                >
                  {isCreating
                    ? t("creating")
                    : mode === "category"
                      ? t("finish")
                      : tCommon("next")}
                </button>
              </div>
            </>
          )}

          {/* ═══ Step 2: Channel Permission Overrides ═══ */}
          {step === 2 && createdChannel && (
            <>
              <p className="create-ch-perm-desc">
                {t("channelPermissionsDesc")}
              </p>

              <ChannelPermissionEditor channel={createdChannel} />

              <div className="add-server-actions">
                <button
                  className="add-server-btn-secondary"
                  onClick={handleBack}
                >
                  {tCommon("back")}
                </button>
                <button
                  className="add-server-btn-primary"
                  onClick={onClose}
                >
                  {t("finish")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default CreateChannelModal;

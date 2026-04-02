/** LandingPage — Public marketing page. CSS: landing.css */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { changeLanguage, type Language } from "../../i18n";
import { getPublicStats } from "../../api/stats";
import RevealOnScroll from "./RevealOnScroll";
import { FEATURES, COMPARISON_ROWS } from "./landingData";
import "../../styles/landing.css";

import { detectOS } from "../../utils/detectOS";

const LANDING_ASSETS = "/static/landing";

const SHOWCASE = [
  { img: "ss-chat", key: "sc1" },
  { img: "ss-voice", key: "sc2" },
  { img: "ss-screenshare", key: "sc3" },
  { img: "ss-dm", key: "sc4" },
] as const;

function LandingPage() {
  const { t, i18n } = useTranslation("landing");
  const navigate = useNavigate();
  const [totalUsers, setTotalUsers] = useState(0);
  const [guideOS, setGuideOS] = useState<"linux" | "windows">("linux");

  useEffect(() => {
    getPublicStats().then((res) => {
      if (res.success && res.data) setTotalUsers(res.data.total_users);
    });
  }, []);

  function handleLangChange(lang: Language) { changeLanguage(lang); }
  function scrollTo(id: string) { document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }

  const currentLang = i18n.language?.startsWith("tr") ? "tr" : "en";
  const lang = currentLang;
  const { url: downloadUrl, i18nKey: downloadKey } = detectOS();

  return (
    <div className="landing-page">
      {/* ── Aurora Background ── */}
      <div className="lp-aurora-wrap">
        <div className="lp-aurora-blob lp-aurora-blob--1" />
        <div className="lp-aurora-blob lp-aurora-blob--2" />
        <div className="lp-aurora-blob lp-aurora-blob--3" />
      </div>
      <div className="lp-grain" />

      <div className="lp-content">

        {/* ═══ NAVBAR ═══ */}
        <nav className="lp-nav">
          <img src="/mqvi-icon.svg" alt="mqvi" className="lp-nav-logo-img" />
          <span className="lp-nav-brand">mqvi</span>

          <div className="lp-nav-links">
            {[
              ["features", t("nav_features")],
              ["comparison", t("nav_compare")],
              ["selfhost", t("nav_selfhost")],
              ["faq", t("nav_faq")],
            ].map(([id, label]) => (
              <button key={id} className="lp-nav-link" onClick={() => scrollTo(id)}>
                {label}
              </button>
            ))}
          </div>

          <div className="lp-nav-lang">
            {(["en", "tr"] as const).map((l) => (
              <button
                key={l}
                className={`lp-nav-lang-btn${currentLang === l ? " lp-nav-lang-btn--active" : ""}`}
                onClick={() => handleLangChange(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>

          <button className="lp-nav-login" onClick={() => navigate("/login")}>
            {t("nav_login")}
          </button>
        </nav>

        {/* ═══ HERO ═══ */}
        <section className="lp-hero">
          {totalUsers > 0 && (
            <div className="lp-hero-user-count">
              <div className="lp-hero-user-dot" />
              {t("hero_userCount", { count: totalUsers })}
            </div>
          )}

          <h1>
            {t("hero_h1_1")}<br />
            <span className="lp-hero-gradient">{t("hero_h1_2")}</span>
          </h1>
          <p className="lp-hero-sub">{t("hero_sub")}</p>

          <a href={downloadUrl} className="lp-download-link" target="_blank" rel="noopener noreferrer">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t(downloadKey)}
          </a>

          {/* Demo Video */}
          <div className="lp-hero-video-wrap">
            <video
              className="lp-hero-video"
              src={`${LANDING_ASSETS}/demo-${lang}.mp4`}
              autoPlay
              muted
              loop
              playsInline
            />
          </div>
        </section>

        {/* ═══ SHOWCASE ═══ */}
        <section className="lp-section">
          <RevealOnScroll>
            <div className="lp-section-label lp-section--center">{t("showcase_label")}</div>
          </RevealOnScroll>

          {SHOWCASE.map((item, i) => (
            <RevealOnScroll key={item.key}>
              <div className={`lp-showcase-row ${i % 2 === 1 ? "lp-showcase-row--reverse" : ""}`}>
                <img
                  className="lp-showcase-img"
                  src={`${LANDING_ASSETS}/${item.img}-${lang}.png`}
                  alt={t(`${item.key}_title`)}
                  loading="lazy"
                />
                <div className="lp-showcase-text">
                  <h3>{t(`${item.key}_title`)}</h3>
                  <p>{t(`${item.key}_desc`)}</p>
                </div>
              </div>
            </RevealOnScroll>
          ))}
        </section>

        {/* ═══ FEATURES ═══ */}
        <section id="features" className="lp-section">
          <RevealOnScroll>
            <div className="lp-features-header">
              <div className="lp-section-label">{t("feat_label")}</div>
              <h2 className="lp-section-title">
                {t("feat_t1")}<br />
                {t("feat_t2")}
              </h2>
              <p className="lp-section-desc">{t("feat_desc")}</p>
            </div>
          </RevealOnScroll>

          <div className="lp-features-grid">
            {FEATURES.map((f, i) => (
              <RevealOnScroll key={f.translationKey} delay={i * 0.06}>
                <div className="lp-feature-card">
                  <div className="lp-feature-card-line" />
                  <h3>{t(`${f.translationKey}_title`)}</h3>
                  <p>{t(`${f.translationKey}_desc`)}</p>
                </div>
              </RevealOnScroll>
            ))}
          </div>
        </section>

        {/* ═══ COMPARISON ═══ */}
        <RevealOnScroll>
          <section id="comparison" className="lp-section lp-section--center">
            <div className="lp-section-label">{t("comp_label")}</div>
            <h2 className="lp-section-title">{t("comp_title")}</h2>
            <p className="lp-section-desc">{t("comp_desc")}</p>

            <div className="lp-comparison-table">
              <div className="lp-comp-header">
                <div className="lp-comp-cell" />
                <div className="lp-comp-cell lp-comp-cell--header lp-comp-cell--mqvi">mqvi</div>
                <div className="lp-comp-cell lp-comp-cell--header lp-comp-cell--other">{t("comp_others")}</div>
              </div>

              {COMPARISON_ROWS.map((row) => (
                <div key={row.key} className="lp-comp-row">
                  <div className="lp-comp-cell">{t(row.key)}</div>
                  <div className="lp-comp-cell lp-comp-cell--mqvi" style={{ justifyContent: "center" }}>
                    {typeof row.mqvi === "string" ? (
                      <span>{t(row.mqvi)}</span>
                    ) : (
                      <span className="lp-comp-check">{"\u2713"}</span>
                    )}
                  </div>
                  <div className="lp-comp-cell" style={{ justifyContent: "center" }}>
                    {typeof row.other === "string" ? (
                      <span className="lp-comp-text-bad">{t(row.other)}</span>
                    ) : row.other ? (
                      <span className="lp-comp-check" style={{ color: "var(--lp-text-muted)" }}>{"\u2713"}</span>
                    ) : (
                      <span className="lp-comp-cross">{"\u2715"}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ SELF-HOST ═══ (unchanged) */}
        <RevealOnScroll>
          <section id="selfhost" className="lp-section">
            <div className="lp-features-header">
              <div className="lp-section-label">{t("sh_label")}</div>
              <h2 className="lp-section-title">
                {t("sh_t1")}<br />
                {t("sh_t2")}
              </h2>
              <p className="lp-section-desc" style={{ margin: "0 auto" }}>
                {t("sh_desc")}
              </p>
            </div>

            <div className="lp-guide-os-tabs">
              <button className={`lp-guide-os-tab ${guideOS === "linux" ? "active" : ""}`} onClick={() => setGuideOS("linux")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.5 2c-.4 0-.8.3-.8.8v.1c-.1.6-.4 1.1-.8 1.5-.5.4-1 .7-1.5.8-.3.1-.5.3-.5.6v.3c0 .6.2 1.2.5 1.7.2.3.2.7.1 1-.2.4-.5.7-.9.9-.4.2-.6.6-.5 1 .2 1 .7 1.9 1.5 2.5-.2.5-.3 1-.3 1.5 0 .7.2 1.3.5 1.9-.8.6-1.3 1.4-1.3 2.2 0 1.8 2 3.2 4.5 3.2s4.5-1.4 4.5-3.2c0-.8-.5-1.6-1.3-2.2.3-.6.5-1.2.5-1.9 0-.5-.1-1-.3-1.5.8-.6 1.3-1.5 1.5-2.5.1-.4-.1-.8-.5-1-.4-.2-.7-.5-.9-.9-.1-.3-.1-.7.1-1 .3-.5.5-1.1.5-1.7v-.3c0-.3-.2-.5-.5-.6-.5-.1-1-.4-1.5-.8-.4-.4-.7-.9-.8-1.5v-.1c0-.5-.4-.8-.8-.8z" />
                </svg>
                {t("guide_os_linux")}
              </button>
              <button className={`lp-guide-os-tab ${guideOS === "windows" ? "active" : ""}`} onClick={() => setGuideOS("windows")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 5.5l7.5-1v7H3V5.5zm0 13l7.5 1v-7H3v6zm8.5 1.2L21 21V12.5h-9.5v7.2zm0-15.4v7.2H21V3l-9.5 1.3z" />
                </svg>
                {t("guide_os_windows")}
              </button>
            </div>

            <div className="lp-guide">
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">1</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s1_title")}</h3>
                  <p className="lp-guide-step-desc">
                    {guideOS === "linux" ? t("guide_s1_desc_linux") : t("guide_s1_desc_windows")}
                  </p>
                  {guideOS === "linux" && (
                    <div className="lp-guide-providers">
                      {["Hetzner", "DigitalOcean", "Oracle Cloud", "AWS", "Contabo"].map((p) => (
                        <span key={p} className="lp-guide-provider-tag">{p}</span>
                      ))}
                    </div>
                  )}
                  <div className="lp-guide-specs">
                    <div className="lp-guide-spec">
                      <span className="lp-guide-spec-label">{t("guide_s1_os")}</span>
                      <span className="lp-guide-spec-val">{guideOS === "linux" ? t("guide_s1_os_linux") : t("guide_s1_os_windows")}</span>
                    </div>
                    <div className="lp-guide-spec">
                      <span className="lp-guide-spec-label">{t("guide_s1_ram")}</span>
                      <span className="lp-guide-spec-val">{t("guide_s1_ram_val")}</span>
                    </div>
                    <div className="lp-guide-spec">
                      <span className="lp-guide-spec-label">{t("guide_s1_cpu")}</span>
                      <span className="lp-guide-spec-val">{t("guide_s1_cpu_val")}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lp-guide-step">
                <div className="lp-guide-step-num">2</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_auto_title")}</h3>
                  <p className="lp-guide-step-desc">
                    {guideOS === "linux" ? t("guide_auto_desc_linux") : t("guide_auto_desc_windows")}
                  </p>
                  <div className="lp-terminal">
                    <div className="lp-terminal-bar">
                      <div className="lp-terminal-dot" style={{ background: "#ff5f57" }} />
                      <div className="lp-terminal-dot" style={{ background: "#febc2e" }} />
                      <div className="lp-terminal-dot" style={{ background: "#28c840" }} />
                    </div>
                    <div className="lp-terminal-body">
                      {guideOS === "linux" ? (
                        <>
                          <div><span className="lp-terminal-comment"># {t("guide_auto_comment_linux")}</span></div>
                          <div>
                            <span className="lp-terminal-cmd">curl</span>{" "}
                            <span className="lp-terminal-flag">-fsSL</span>{" "}
                            <span className="lp-terminal-url">https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.sh</span>{" "}
                            | <span className="lp-terminal-cmd">sudo bash</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div><span className="lp-terminal-comment"># {t("guide_auto_comment_windows")}</span></div>
                          <div>
                            <span className="lp-terminal-cmd">irm</span>{" "}
                            <span className="lp-terminal-url">https://raw.githubusercontent.com/akinalpfdn/Mqvi/main/deploy/livekit-setup.ps1</span>{" "}
                            | <span className="lp-terminal-cmd">iex</span>
                          </div>
                        </>
                      )}
                      <br />
                      <div><span className="lp-terminal-ok">{"\u2713"}</span> LiveKit is running!</div>
                    </div>
                  </div>
                  {guideOS === "windows" && (
                    <div className="lp-guide-tip">
                      <span className="lp-guide-tip-icon">!</span>
                      <span>{t("guide_auto_note_windows")}</span>
                    </div>
                  )}
                  <p className="lp-guide-step-desc" style={{ marginTop: 16 }}>
                    {t("guide_auto_output")}
                  </p>
                  <div className="lp-guide-fields">
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">URL</span>
                      <span className="lp-guide-field-val">ws://203.0.113.10:7880</span>
                    </div>
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">API Key</span>
                      <span className="lp-guide-field-val">LiveKitKeyf3a1b2c4</span>
                    </div>
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">API Secret</span>
                      <span className="lp-guide-field-val">aBcDeFgHiJkLmNoPqRsTuVwXyZ012345</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lp-guide-step">
                <div className="lp-guide-step-num">3</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_connect_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_connect_desc")}</p>
                  <div className="lp-guide-tip">
                    <span className="lp-guide-tip-icon">*</span>
                    <span>{t("guide_connect_tip")}</span>
                  </div>
                </div>
              </div>

              <div className="lp-guide-ssl-warning">
                <div className="lp-guide-ssl-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div className="lp-guide-ssl-content">
                  <h4 className="lp-guide-ssl-title">{t("guide_ssl_title")}</h4>
                  <p className="lp-guide-ssl-desc">{t("guide_ssl_desc")}</p>
                </div>
              </div>

              <div className="lp-guide-troubleshoot">
                <h3 className="lp-guide-troubleshoot-title">{t("guide_trouble_title")}</h3>
                <div className="lp-guide-trouble-grid">
                  {([1, 2, 3, 4] as const).map((n) => (
                    <div key={n} className="lp-guide-trouble-card">
                      <div className="lp-guide-trouble-q">{t(`guide_trouble_q${n}`)}</div>
                      <div className="lp-guide-trouble-a">{t(`guide_trouble_a${n}`)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ FAQ ═══ */}
        <RevealOnScroll>
          <section id="faq" className="lp-section lp-section--center">
            <span className="lp-section-label">{t("faq_label")}</span>
            <h2 className="lp-section-title">{t("faq_title")}</h2>
            <div className="lp-faq-grid">
              {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => (
                <div key={n} className="lp-faq-item">
                  <h3 className="lp-faq-q">{t(`faq_q${n}`)}</h3>
                  <p className="lp-faq-a">{t(`faq_a${n}`)}</p>
                </div>
              ))}
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ CTA ═══ */}
        <RevealOnScroll>
          <section id="cta" className="lp-cta">
            <div className="lp-cta-glow" />
            <h2>
              {t("cta_t1")}<br />
              <span className="lp-hero-gradient">{t("cta_t2")}</span>
            </h2>
            <p>{t("cta_desc")}</p>
            <div className="lp-cta-actions">
              <button className="lp-btn-primary" onClick={() => navigate("/register")}>
                {t("cta_btn1")}
              </button>
              <button
                className="lp-btn-secondary"
                onClick={() => window.open("https://github.com/akinalpfdn/Mqvi", "_blank")}
              >
                {t("cta_btn2")}
              </button>
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ FOOTER ═══ */}
        <footer className="lp-footer">
          <div className="lp-footer-left">
            <img src="/mqvi-icon.svg" alt="mqvi" className="lp-footer-logo-img" />
            <span className="lp-footer-copy">{t("footer_copy")}</span>
          </div>
          <div className="lp-footer-links">
            <a href="https://github.com/akinalpfdn/Mqvi" target="_blank" rel="noopener noreferrer" className="lp-footer-link">GitHub</a>
            <a href="/privacy" className="lp-footer-link">{t("footer_privacy")}</a>
            <a href="/terms" className="lp-footer-link">{t("footer_terms")}</a>
          </div>
        </footer>

      </div>
    </div>
  );
}

export default LandingPage;

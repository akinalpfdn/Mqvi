/**
 * LandingPage — mqvi public tanıtım sayfası.
 *
 * Unauthenticated kullanıcılar "/" rotasına geldiğinde gösterilir.
 *
 * Section'lar:
 * 1. Navbar — logo, section linkler, EN/TR toggle, "Giriş Yap" butonu
 * 2. Hero — kullanıcı sayısı badge, başlık, CTA
 * 3. Problem — kimlik doğrulama sorunu + ID card mockup
 * 4. Features — 9 özellik kartı (3x3 grid)
 * 5. Comparison — mqvi vs diğerleri tablosu
 * 6. Roadmap — Shipped / In Progress / Planned sütunları
 * 7. Self-Host — terminal mockup
 * 8. CTA — son çağrı, register'a yönlendir
 * 9. Footer
 *
 * CSS: landing.css (ayrı dosya, uygulama temasını etkilemez)
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { changeLanguage, type Language } from "../../i18n";
import { getPublicStats } from "../../api/stats";
import FeatureCard from "./FeatureCard";
import RoadmapColumn from "./RoadmapColumn";
import RevealOnScroll from "./RevealOnScroll";
import {
  FEATURES,
  COMPARISON_ROWS,
  ROADMAP_DONE,
  ROADMAP_WIP,
  ROADMAP_PLANNED,
} from "./landingData";
import "../../styles/landing.css";

function LandingPage() {
  const { t, i18n } = useTranslation("landing");
  const navigate = useNavigate();
  const [totalUsers, setTotalUsers] = useState(0);
  const [guideOS, setGuideOS] = useState<"linux" | "windows">("linux");

  // Toplam kullanıcı sayısını çek (mount'ta bir kez)
  useEffect(() => {
    getPublicStats().then((res) => {
      if (res.success && res.data) {
        setTotalUsers(res.data.total_users);
      }
    });
  }, []);

  /** Dil değiştirme — hem i18n hem localStorage güncellenir */
  function handleLangChange(lang: Language) {
    changeLanguage(lang);
  }

  /** Section'a smooth scroll */
  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  const currentLang = i18n.language?.startsWith("tr") ? "tr" : "en";

  return (
    <div className="landing-page">
      {/* ── Aurora Background ── */}
      <div className="lp-aurora-wrap">
        <div className="lp-aurora-blob lp-aurora-blob--1" />
        <div className="lp-aurora-blob lp-aurora-blob--2" />
        <div className="lp-aurora-blob lp-aurora-blob--3" />
      </div>

      {/* ── Grain Overlay ── */}
      <div className="lp-grain" />

      {/* ── Content ── */}
      <div className="lp-content">

        {/* ═══ NAVBAR ═══ */}
        <nav className="lp-nav">
          <div className="lp-nav-logo">m</div>
          <span className="lp-nav-brand">mqvi</span>

          <div className="lp-nav-links">
            {[
              ["features", t("nav_features")],
              ["comparison", t("nav_compare")],
              ["roadmap", t("nav_roadmap")],
              ["selfhost", t("nav_selfhost")],
            ].map(([id, label]) => (
              <button
                key={id}
                className="lp-nav-link"
                onClick={() => scrollTo(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Dil toggle */}
          <div className="lp-nav-lang">
            {(["en", "tr"] as const).map((lang) => (
              <button
                key={lang}
                className={`lp-nav-lang-btn${currentLang === lang ? " lp-nav-lang-btn--active" : ""}`}
                onClick={() => handleLangChange(lang)}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Giriş Yap butonu */}
          <button className="lp-nav-login" onClick={() => navigate("/login")}>
            {t("nav_login")}
          </button>
        </nav>

        {/* ═══ HERO ═══ */}
        <section className="lp-hero">
          {/* Kullanıcı sayısı badge — 0'dan büyükse göster */}
          {totalUsers > 0 && (
            <div className="lp-hero-user-count">
              <div className="lp-hero-user-dot" />
              {t("hero_userCount", { count: totalUsers })}
            </div>
          )}

          {/* Uyarı badge */}
          <div className="lp-hero-badge">
            <div className="lp-hero-badge-dot" />
            {t("hero_badge")}
          </div>

          {/* Başlık */}
          <h1>
            {t("hero_h1_1")}<br />
            {t("hero_h1_2")}<br />
            <span className="lp-hero-gradient">{t("hero_h1_3")}</span>
          </h1>

          {/* Alt başlık */}
          <p>{t("hero_sub")}</p>

          {/* CTA butonları */}
          <div className="lp-hero-actions">
            <button className="lp-btn-primary" onClick={() => navigate("/register")}>
              {t("hero_cta")}
            </button>
            <button className="lp-btn-secondary" onClick={() => scrollTo("features")}>
              {t("hero_cta2")}
            </button>
          </div>

          {/* Desktop download */}
          <a
            href="https://github.com/akinalpfdn/Mqvi/releases/latest/download/mqvi-setup.exe"
            className="lp-download-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t("hero_download")}
          </a>

          {/* Scroll indicator */}
          <div className="lp-hero-scroll">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </div>
        </section>

        {/* ═══ PROBLEM ═══ */}
        <RevealOnScroll>
          <section className="lp-section">
            <div className="lp-problem">
              {/* Sol: Metin */}
              <div className="lp-problem-left">
                <div className="lp-section-label">{t("problem_label")}</div>
                <h2 className="lp-section-title">
                  {t("problem_t1")}<br />
                  {t("problem_t2")}<br />
                  {t("problem_t3")}
                </h2>
                <p className="lp-section-desc">{t("problem_desc")}</p>
              </div>

              {/* Sağ: ID Card mockup */}
              <div className="lp-problem-right">
                <div className="lp-id-card">
                  <div className="lp-id-card-bar" />
                  <div className="lp-id-card-header">
                    <div className="lp-id-card-icon">{"\uD83E\uDEAA"}</div>
                    {t("id_header")}
                  </div>
                  {(["id_name", "id_number", "id_dob"] as const).map((key) => (
                    <div key={key} className="lp-id-card-row">
                      <span className="lp-id-card-label">{t(key)}</span>
                      <div className="lp-id-card-redacted" />
                    </div>
                  ))}
                  <div className="lp-id-card-row">
                    <span className="lp-id-card-label">{t("id_photo")}</span>
                    <span className="lp-id-card-upload">{"\uD83D\uDCF7"} {t("id_upload")}</span>
                  </div>
                  <div className="lp-id-card-stamp">{t("id_stamp")}</div>
                </div>
              </div>
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ FEATURES ═══ */}
        <section id="features" className="lp-section">
          <RevealOnScroll>
            <div className="lp-features-header">
              <div className="lp-section-label">{t("feat_label")}</div>
              <h2 className="lp-section-title">
                {t("feat_t1")}<br />
                {t("feat_t2")}
              </h2>
              <p className="lp-section-desc" style={{ margin: "0 auto" }}>
                {t("feat_desc")}
              </p>
            </div>
          </RevealOnScroll>

          <div className="lp-features-grid">
            {FEATURES.map((f, i) => (
              <FeatureCard
                key={f.translationKey}
                icon={f.icon}
                tag={f.tag}
                bgColor={f.bgColor}
                translationKey={f.translationKey}
                delay={i * 0.06}
              />
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
              {/* Header */}
              <div className="lp-comp-header">
                <div className="lp-comp-cell" />
                <div className="lp-comp-cell lp-comp-cell--header lp-comp-cell--mqvi">mqvi</div>
                <div className="lp-comp-cell lp-comp-cell--header lp-comp-cell--other">{t("comp_others")}</div>
              </div>

              {/* Rows */}
              {COMPARISON_ROWS.map((row) => (
                <div key={row.key} className="lp-comp-row">
                  {/* Feature name */}
                  <div className="lp-comp-cell">{t(row.key)}</div>

                  {/* mqvi column */}
                  <div className="lp-comp-cell lp-comp-cell--mqvi" style={{ justifyContent: "center" }}>
                    {typeof row.mqvi === "string" ? (
                      <span>{t(row.mqvi)}</span>
                    ) : (
                      <span className="lp-comp-check">{"\u2713"}</span>
                    )}
                  </div>

                  {/* Others column */}
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

        {/* ═══ ROADMAP ═══ */}
        <section id="roadmap" className="lp-section">
          <RevealOnScroll>
            <div className="lp-features-header">
              <div className="lp-section-label">{t("road_label")}</div>
              <h2 className="lp-section-title">
                {t("road_t1")}<br />
                {t("road_t2")}
              </h2>
              <p className="lp-section-desc" style={{ margin: "0 auto" }}>
                {t("road_desc")}
              </p>
            </div>
          </RevealOnScroll>

          <RevealOnScroll delay={0.1}>
            <div className="lp-roadmap-grid">
              <RoadmapColumn title={t("road_done")} color="#22c55e" items={ROADMAP_DONE} />
              <RoadmapColumn title={t("road_wip")} color="var(--lp-accent)" items={ROADMAP_WIP} />
              <RoadmapColumn title={t("road_plan")} color="var(--lp-secondary)" items={ROADMAP_PLANNED} />
            </div>
          </RevealOnScroll>
        </section>

        {/* ═══ SELF-HOST ═══ */}
        <RevealOnScroll>
          <section id="selfhost" className="lp-section">
            {/* Başlık */}
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

            {/* OS Tab Bar */}
            <div className="lp-guide-os-tabs">
              <button
                className={`lp-guide-os-tab ${guideOS === "linux" ? "active" : ""}`}
                onClick={() => setGuideOS("linux")}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.5 2c-.4 0-.8.3-.8.8v.1c-.1.6-.4 1.1-.8 1.5-.5.4-1 .7-1.5.8-.3.1-.5.3-.5.6v.3c0 .6.2 1.2.5 1.7.2.3.2.7.1 1-.2.4-.5.7-.9.9-.4.2-.6.6-.5 1 .2 1 .7 1.9 1.5 2.5-.2.5-.3 1-.3 1.5 0 .7.2 1.3.5 1.9-.8.6-1.3 1.4-1.3 2.2 0 1.8 2 3.2 4.5 3.2s4.5-1.4 4.5-3.2c0-.8-.5-1.6-1.3-2.2.3-.6.5-1.2.5-1.9 0-.5-.1-1-.3-1.5.8-.6 1.3-1.5 1.5-2.5.1-.4-.1-.8-.5-1-.4-.2-.7-.5-.9-.9-.1-.3-.1-.7.1-1 .3-.5.5-1.1.5-1.7v-.3c0-.3-.2-.5-.5-.6-.5-.1-1-.4-1.5-.8-.4-.4-.7-.9-.8-1.5v-.1c0-.5-.4-.8-.8-.8z" />
                </svg>
                {t("guide_os_linux")}
              </button>
              <button
                className={`lp-guide-os-tab ${guideOS === "windows" ? "active" : ""}`}
                onClick={() => setGuideOS("windows")}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 5.5l7.5-1v7H3V5.5zm0 13l7.5 1v-7H3v6zm8.5 1.2L21 21V12.5h-9.5v7.2zm0-15.4v7.2H21V3l-9.5 1.3z" />
                </svg>
                {t("guide_os_windows")}
              </button>
            </div>

            {/* Adım adım rehber */}
            <div className="lp-guide">
              {/* Adım 1: Sunucu Edin */}
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
                      <span className="lp-guide-spec-val">
                        {guideOS === "linux" ? t("guide_s1_os_linux") : t("guide_s1_os_windows")}
                      </span>
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

              {/* Adım 2: Kurulum Script'ini Çalıştır */}
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
                      <span className="lp-guide-tip-icon">{"\u26A0\uFE0F"}</span>
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

              {/* Adım 3: mqvi'ye Bağla */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">3</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_connect_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_connect_desc")}</p>
                  <div className="lp-guide-tip">
                    <span className="lp-guide-tip-icon">{"\u2705"}</span>
                    <span>{t("guide_connect_tip")}</span>
                  </div>
                </div>
              </div>

              {/* Hata durumları */}
              <div className="lp-guide-troubleshoot">
                <h3 className="lp-guide-troubleshoot-title">{t("guide_trouble_title")}</h3>
                <div className="lp-guide-trouble-grid">
                  <div className="lp-guide-trouble-card">
                    <div className="lp-guide-trouble-q">{t("guide_trouble_q1")}</div>
                    <div className="lp-guide-trouble-a">{t("guide_trouble_a1")}</div>
                  </div>
                  <div className="lp-guide-trouble-card">
                    <div className="lp-guide-trouble-q">{t("guide_trouble_q2")}</div>
                    <div className="lp-guide-trouble-a">{t("guide_trouble_a2")}</div>
                  </div>
                  <div className="lp-guide-trouble-card">
                    <div className="lp-guide-trouble-q">{t("guide_trouble_q3")}</div>
                    <div className="lp-guide-trouble-a">{t("guide_trouble_a3")}</div>
                  </div>
                  <div className="lp-guide-trouble-card">
                    <div className="lp-guide-trouble-q">{t("guide_trouble_q4")}</div>
                    <div className="lp-guide-trouble-a">{t("guide_trouble_a4")}</div>
                  </div>
                </div>
              </div>
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
                onClick={() => window.open("https://github.com", "_blank")}
              >
                {t("cta_btn2")}
              </button>
            </div>
          </section>
        </RevealOnScroll>

        {/* ═══ FOOTER ═══ */}
        <footer className="lp-footer">
          <div className="lp-footer-left">
            <div className="lp-footer-logo">m</div>
            <span className="lp-footer-copy">{t("footer_copy")}</span>
          </div>
          <div className="lp-footer-links">
            <a href="#" className="lp-footer-link">{t("footer_docs")}</a>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="lp-footer-link">GitHub</a>
            <a href="#" className="lp-footer-link">{t("footer_privacy")}</a>
          </div>
        </footer>

      </div>
    </div>
  );
}

export default LandingPage;

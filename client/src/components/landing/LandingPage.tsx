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

            {/* Adım adım rehber */}
            <div className="lp-guide">
              {/* Adım 1: Sunucu Edin */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">1</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s1_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s1_desc")}</p>
                  <div className="lp-guide-providers">
                    {["Hetzner", "DigitalOcean", "Oracle Cloud", "AWS", "Contabo"].map((p) => (
                      <span key={p} className="lp-guide-provider-tag">{p}</span>
                    ))}
                  </div>
                  <div className="lp-guide-specs">
                    <div className="lp-guide-spec">
                      <span className="lp-guide-spec-label">{t("guide_s1_os")}</span>
                      <span className="lp-guide-spec-val">Ubuntu 22.04 / Debian 12</span>
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

              {/* Adım 2: Docker Kur */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">2</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s2_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s2_desc")}</p>
                  <div className="lp-terminal">
                    <div className="lp-terminal-bar">
                      <div className="lp-terminal-dot" style={{ background: "#ff5f57" }} />
                      <div className="lp-terminal-dot" style={{ background: "#febc2e" }} />
                      <div className="lp-terminal-dot" style={{ background: "#28c840" }} />
                    </div>
                    <div className="lp-terminal-body">
                      <div><span className="lp-terminal-comment"># {t("guide_s2_c1")}</span></div>
                      <div>
                        <span className="lp-terminal-cmd">curl</span>{" "}
                        <span className="lp-terminal-flag">-fsSL</span>{" "}
                        <span className="lp-terminal-url">https://get.docker.com</span>{" "}
                        | <span className="lp-terminal-cmd">sh</span>
                      </div>
                      <br />
                      <div><span className="lp-terminal-comment"># {t("guide_s2_c2")}</span></div>
                      <div>
                        <span className="lp-terminal-cmd">docker</span> --version
                      </div>
                      <div><span className="lp-terminal-ok">{"\u2713"}</span> Docker 27.x.x</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Adım 3: Firewall / Port */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">3</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s3_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s3_desc")}</p>
                  <div className="lp-guide-port-table">
                    <div className="lp-guide-port-row lp-guide-port-row--header">
                      <span>{t("guide_s3_port")}</span>
                      <span>{t("guide_s3_proto")}</span>
                      <span>{t("guide_s3_usage")}</span>
                    </div>
                    <div className="lp-guide-port-row">
                      <span className="lp-guide-port-num">7880</span>
                      <span>TCP</span>
                      <span>{t("guide_s3_p7880")}</span>
                    </div>
                    <div className="lp-guide-port-row">
                      <span className="lp-guide-port-num">7881</span>
                      <span>TCP</span>
                      <span>{t("guide_s3_p7881")}</span>
                    </div>
                    <div className="lp-guide-port-row">
                      <span className="lp-guide-port-num">7882</span>
                      <span>UDP</span>
                      <span>{t("guide_s3_p7882")}</span>
                    </div>
                    <div className="lp-guide-port-row">
                      <span className="lp-guide-port-num">50000–60000</span>
                      <span>UDP</span>
                      <span>{t("guide_s3_prange")}</span>
                    </div>
                  </div>
                  <div className="lp-terminal">
                    <div className="lp-terminal-bar">
                      <div className="lp-terminal-dot" style={{ background: "#ff5f57" }} />
                      <div className="lp-terminal-dot" style={{ background: "#febc2e" }} />
                      <div className="lp-terminal-dot" style={{ background: "#28c840" }} />
                    </div>
                    <div className="lp-terminal-body">
                      <div><span className="lp-terminal-comment"># {t("guide_s3_c1")}</span></div>
                      <div><span className="lp-terminal-cmd">sudo ufw allow</span> 7880:7882/tcp</div>
                      <div><span className="lp-terminal-cmd">sudo ufw allow</span> 7882/udp</div>
                      <div><span className="lp-terminal-cmd">sudo ufw allow</span> 50000:60000/udp</div>
                      <br />
                      <div><span className="lp-terminal-comment"># {t("guide_s3_c2")}</span></div>
                      <div><span className="lp-terminal-cmd">sudo ufw enable</span></div>
                      <div><span className="lp-terminal-cmd">sudo ufw status</span></div>
                    </div>
                  </div>
                  <div className="lp-guide-tip">
                    <span className="lp-guide-tip-icon">{"\u26A0\uFE0F"}</span>
                    <span>{t("guide_s3_tip")}</span>
                  </div>
                </div>
              </div>

              {/* Adım 4: LiveKit Kur */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">4</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s4_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s4_desc")}</p>
                  <div className="lp-terminal">
                    <div className="lp-terminal-bar">
                      <div className="lp-terminal-dot" style={{ background: "#ff5f57" }} />
                      <div className="lp-terminal-dot" style={{ background: "#febc2e" }} />
                      <div className="lp-terminal-dot" style={{ background: "#28c840" }} />
                    </div>
                    <div className="lp-terminal-body">
                      <div><span className="lp-terminal-comment"># {t("guide_s4_c1")}</span></div>
                      <div>
                        <span className="lp-terminal-cmd">docker</span> run{" "}
                        <span className="lp-terminal-flag">-d</span> \
                      </div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">--name</span> livekit \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">-p</span> 7880:7880 \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">-p</span> 7881:7881 \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">-p</span> 7882:7882/udp \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">-p</span> 50000-60000:50000-60000/udp \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">-v</span> ./livekit.yaml:/etc/livekit.yaml \</div>
                      <div>&nbsp;&nbsp;livekit/livekit-server \</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">--config</span> /etc/livekit.yaml</div>
                      <br />
                      <div><span className="lp-terminal-ok">{"\u2713"}</span> LiveKit {t("guide_s4_ok")}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Adım 5: Config dosyası */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">5</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s5_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s5_desc")}</p>
                  <div className="lp-terminal">
                    <div className="lp-terminal-bar">
                      <div className="lp-terminal-dot" style={{ background: "#ff5f57" }} />
                      <div className="lp-terminal-dot" style={{ background: "#febc2e" }} />
                      <div className="lp-terminal-dot" style={{ background: "#28c840" }} />
                    </div>
                    <div className="lp-terminal-body">
                      <div><span className="lp-terminal-comment"># livekit.yaml</span></div>
                      <div><span className="lp-terminal-flag">port</span>: 7880</div>
                      <div><span className="lp-terminal-flag">rtc</span>:</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">port_range_start</span>: 50000</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">port_range_end</span>: 60000</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-flag">use_external_ip</span>: true</div>
                      <div><span className="lp-terminal-flag">keys</span>:</div>
                      <div>&nbsp;&nbsp;<span className="lp-terminal-cmd">myapikey</span>: <span className="lp-terminal-url">mysecretkey123456</span></div>
                    </div>
                  </div>
                  <div className="lp-guide-tip">
                    <span className="lp-guide-tip-icon">{"\uD83D\uDCA1"}</span>
                    <span>{t("guide_s5_tip")}</span>
                  </div>
                </div>
              </div>

              {/* Adım 6: mqvi'ye bağla */}
              <div className="lp-guide-step">
                <div className="lp-guide-step-num">6</div>
                <div className="lp-guide-step-content">
                  <h3 className="lp-guide-step-title">{t("guide_s6_title")}</h3>
                  <p className="lp-guide-step-desc">{t("guide_s6_desc")}</p>
                  <div className="lp-guide-fields">
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">LiveKit URL</span>
                      <span className="lp-guide-field-val">wss://your-server.com:7880</span>
                    </div>
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">API Key</span>
                      <span className="lp-guide-field-val">myapikey</span>
                    </div>
                    <div className="lp-guide-field">
                      <span className="lp-guide-field-label">API Secret</span>
                      <span className="lp-guide-field-val">mysecretkey123456</span>
                    </div>
                  </div>
                  <div className="lp-guide-tip">
                    <span className="lp-guide-tip-icon">{"\u2705"}</span>
                    <span>{t("guide_s6_tip")}</span>
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

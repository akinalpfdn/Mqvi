/** TermsPage — Public terms of service page. Reuses landing page styling. */

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { changeLanguage, type Language } from "../../i18n";
import "../../styles/landing.css";

function TermsPage() {
  const { t, i18n } = useTranslation("terms");
  const navigate = useNavigate();

  function toggleLang() {
    const next: Language = i18n.language === "tr" ? "en" : "tr";
    changeLanguage(next);
  }

  return (
    <div className="landing-page">
      <div className="lp-scroll-wrap">
        {/* Nav */}
        <nav className="lp-nav">
          <div className="lp-nav-left" onClick={() => navigate("/")} style={{ cursor: "pointer" }}>
            <img src="/mqvi-icon.svg" alt="mqvi" className="lp-nav-logo-img" />
            <span className="lp-nav-brand">mqvi</span>
          </div>
          <div className="lp-nav-right">
            <button className="lp-lang-toggle" onClick={toggleLang}>
              {i18n.language === "tr" ? "EN" : "TR"}
            </button>
          </div>
        </nav>

        {/* Content */}
        <main className="privacy-content">
          <h1>{t("title")}</h1>
          <p className="privacy-updated">{t("lastUpdated")}</p>

          <section>
            <h2>{t("acceptanceTitle")}</h2>
            <p>{t("acceptanceDesc")}</p>
          </section>

          <section>
            <h2>{t("serviceTitle")}</h2>
            <p>{t("serviceDesc")}</p>
          </section>

          <section>
            <h2>{t("accountTitle")}</h2>
            <p>{t("accountDesc")}</p>
          </section>

          <section>
            <h2>{t("contentTitle")}</h2>
            <p>{t("contentDesc")}</p>
          </section>

          <section>
            <h2>{t("conductTitle")}</h2>
            <p>{t("conductDesc")}</p>
            <ul>
              <li>{t("conductItem1")}</li>
              <li>{t("conductItem2")}</li>
              <li>{t("conductItem3")}</li>
              <li>{t("conductItem4")}</li>
              <li>{t("conductItem5")}</li>
            </ul>
          </section>

          <section>
            <h2>{t("ipTitle")}</h2>
            <p>{t("ipDesc")}</p>
          </section>

          <section>
            <h2>{t("disclaimerTitle")}</h2>
            <p>{t("disclaimerDesc")}</p>
          </section>

          <section>
            <h2>{t("liabilityTitle")}</h2>
            <p>{t("liabilityDesc")}</p>
          </section>

          <section>
            <h2>{t("indemnityTitle")}</h2>
            <p>{t("indemnityDesc")}</p>
          </section>

          <section>
            <h2>{t("terminationTitle")}</h2>
            <p>{t("terminationDesc")}</p>
          </section>

          <section>
            <h2>{t("copyrightTitle")}</h2>
            <p>{t("copyrightDesc")}</p>
          </section>

          <section>
            <h2>{t("selfHostTitle")}</h2>
            <p>{t("selfHostDesc")}</p>
          </section>

          <section>
            <h2>{t("voiceTitle")}</h2>
            <p>{t("voiceDesc")}</p>
          </section>

          <section>
            <h2>{t("changesTitle")}</h2>
            <p>{t("changesDesc")}</p>
          </section>

          <section>
            <h2>{t("lawTitle")}</h2>
            <p>{t("lawDesc")}</p>
          </section>

          <section>
            <h2>{t("contactTitle")}</h2>
            <p>{t("contactDesc")}</p>
          </section>
        </main>

        {/* Footer */}
        <footer className="lp-footer">
          <div className="lp-footer-left">
            <img src="/mqvi-icon.svg" alt="mqvi" className="lp-footer-logo-img" />
            <span className="lp-footer-copy">{t("footerCopy")}</span>
          </div>
          <div className="lp-footer-links">
            <a href="https://github.com/akinalpfdn/Mqvi" target="_blank" rel="noopener noreferrer" className="lp-footer-link">GitHub</a>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default TermsPage;

/** PrivacyPage — Public privacy policy page. Reuses landing page styling. */

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { changeLanguage, type Language } from "../../i18n";
import "../../styles/landing.css";

function PrivacyPage() {
  const { t, i18n } = useTranslation("privacy");
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
            <h2>{t("introTitle")}</h2>
            <p>{t("introDesc")}</p>
          </section>

          <section>
            <h2>{t("dataCollectedTitle")}</h2>
            <ul>
              <li>{t("dataItem1")}</li>
              <li>{t("dataItem2")}</li>
              <li>{t("dataItem3")}</li>
              <li>{t("dataItem4")}</li>
            </ul>
          </section>

          <section>
            <h2>{t("dataUsageTitle")}</h2>
            <p>{t("dataUsageDesc")}</p>
            <ul>
              <li>{t("usageItem1")}</li>
              <li>{t("usageItem2")}</li>
              <li>{t("usageItem3")}</li>
            </ul>
          </section>

          <section>
            <h2>{t("noTrackingTitle")}</h2>
            <p>{t("noTrackingDesc")}</p>
          </section>

          <section>
            <h2>{t("dataSharingTitle")}</h2>
            <p>{t("dataSharingDesc")}</p>
          </section>

          <section>
            <h2>{t("selfHostTitle")}</h2>
            <p>{t("selfHostDesc")}</p>
          </section>

          <section>
            <h2>{t("deletionTitle")}</h2>
            <p>{t("deletionDesc")}</p>
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

export default PrivacyPage;

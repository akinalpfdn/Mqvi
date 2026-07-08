/** TermsPage — Public terms of service page. */

import { useTranslation } from "react-i18next";
import LegalPageShell from "./LegalPageShell";

function TermsPage() {
  const { t } = useTranslation("terms");

  return (
    <LegalPageShell ns="terms">
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
        <h2>{t("moderationTitle")}</h2>
        <p>{t("moderationDesc")}</p>
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
    </LegalPageShell>
  );
}

export default TermsPage;

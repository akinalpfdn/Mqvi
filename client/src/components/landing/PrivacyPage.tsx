/** PrivacyPage — Public privacy policy page. */

import { useTranslation } from "react-i18next";
import LegalPageShell from "./LegalPageShell";

function PrivacyPage() {
  const { t } = useTranslation("privacy");

  return (
    <LegalPageShell ns="privacy">
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
          <li>{t("dataItem5")}</li>
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
    </LegalPageShell>
  );
}

export default PrivacyPage;

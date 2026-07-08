/**
 * DeleteAccountPage — Public account-deletion instructions.
 * Required by Google Play's Data Safety form (account deletion URL).
 */

import { useTranslation } from "react-i18next";
import LegalPageShell from "./LegalPageShell";

function DeleteAccountPage() {
  const { t } = useTranslation("privacy");

  return (
    <LegalPageShell ns="privacy">
      <h1>{t("delTitle")}</h1>
      <p className="privacy-updated">{t("lastUpdated")}</p>

      <section>
        <p>{t("delIntro")}</p>
      </section>

      <section>
        <h2>{t("delStepsTitle")}</h2>
        <ul>
          <li>{t("delStep1")}</li>
          <li>{t("delStep2")}</li>
          <li>{t("delStep3")}</li>
          <li>{t("delStep4")}</li>
        </ul>
      </section>

      <section>
        <h2>{t("delDataTitle")}</h2>
        <ul>
          <li>{t("delData1")}</li>
          <li>{t("delData2")}</li>
          <li>{t("delData3")}</li>
        </ul>
      </section>

      <section>
        <h2>{t("delPartialTitle")}</h2>
        <p>{t("delPartialIntro")}</p>
        <ul>
          <li>{t("delPartial1")}</li>
          <li>{t("delPartial2")}</li>
          <li>{t("delPartial3")}</li>
        </ul>
      </section>

      <section>
        <h2>{t("contactTitle")}</h2>
        <p>{t("contactDesc")}</p>
      </section>
    </LegalPageShell>
  );
}

export default DeleteAccountPage;

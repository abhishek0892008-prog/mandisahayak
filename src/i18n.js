import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enTranslation from "./locales/en/translation.json";
import hiTranslation from "./locales/hi/translation.json";

/**
 * The stored language preference.
 *
 * This is the one sanctioned use of localStorage in the application
 * (architecture §18.8): it is not sensitive, and it must be available before
 * the first paint, which rules out waiting for `GET /me`. Once a session
 * exists, `users.locale` becomes authoritative and AuthProvider reconciles the
 * two.
 */
function initialLanguage() {
  try {
    const stored = localStorage.getItem("fq.language");
    if (stored === "en" || stored === "hi") return stored;
  } catch {
    // Storage may be unavailable; fall through to the default.
  }

  return "en";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: enTranslation },
    hi: { translation: hiTranslation },
  },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;

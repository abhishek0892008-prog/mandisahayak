import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en/translation.json";
import hi from "./locales/hi/translation.json";

import { isSupportedLanguage } from "./lib/languages";

const getInitialLanguage = () => {
  try {
    const stored = localStorage.getItem("mandiSahayakLanguage");

    if (isSupportedLanguage(stored)) {
      return stored;
    }
  } catch {
    return "en";
  }

  return "en";
};

/**
 * Whether the farmer has ever picked a language.
 *
 * The chooser is shown on first launch only; once a choice exists the app opens
 * straight onto the portal picker instead of asking again every visit.
 */
export function hasStoredLanguage() {
  try {
    return isSupportedLanguage(localStorage.getItem("mandiSahayakLanguage"));
  } catch {
    return false;
  }
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
    },
    lng: getInitialLanguage(),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  });

i18n.on("languageChanged", (language) => {
  try {
    localStorage.setItem("mandiSahayakLanguage", language);
  } catch {
    return;
  }
});

export default i18n;
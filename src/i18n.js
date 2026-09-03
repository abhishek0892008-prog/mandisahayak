import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en/translation.json";
import hi from "./locales/hi/translation.json";
import pa from "./locales/pa/translation.json";
import mr from "./locales/mr/translation.json";
import te from "./locales/te/translation.json";
import bn from "./locales/bn/translation.json";
import or from "./locales/or/translation.json";
import ta from "./locales/ta/translation.json";
import kn from "./locales/kn/translation.json";

import { isSupportedLanguage } from "./lib/languages";

const getInitialLanguage = () => {
  try {
    const stored = localStorage.getItem("farmqueueLanguage");

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
    return isSupportedLanguage(localStorage.getItem("farmqueueLanguage"));
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
      pa: { translation: pa },
      mr: { translation: mr },
      te: { translation: te },
      bn: { translation: bn },
      or: { translation: or },
      ta: { translation: ta },
      kn: { translation: kn },
    },
    lng: getInitialLanguage(),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
  });

i18n.on("languageChanged", (language) => {
  try {
    localStorage.setItem("farmqueueLanguage", language);
  } catch {
    return;
  }
});

export default i18n;
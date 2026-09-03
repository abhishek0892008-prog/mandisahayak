import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";
import { LANGUAGES } from "../lib/languages";

/**
 * Language switch, available on every screen.
 *
 * A `<select>` rather than a row of buttons: there are nine languages, and nine
 * buttons do not fit a phone header. Options are labelled in their own script
 * for the same reason the chooser screen is.
 *
 * When there is a session the choice is mirrored to `users.locale` so the
 * server renders notifications in the chosen language. The local preference
 * applies immediately either way.
 */
export function LanguageToggle({ variant = "onColour" }) {
  const { t, i18n } = useTranslation();
  const { changeLanguage } = useAuth();

  // Only "onLight" is the pale variant. Callers pass "onColour" and "onGreen"
  // for the same coloured-header case, so anything else defaults to that rather
  // than rendering pale-on-green.
  const classes =
    variant === "onLight"
      ? "border-slate-200 bg-slate-100 text-slate-700"
      : "border-white/25 bg-white/15 text-white [&>option]:text-slate-900";

  const active = LANGUAGES.some((language) => language.code === i18n.language)
    ? i18n.language
    : "en";

  return (
    <select
      value={active}
      aria-label={t("chooseLanguage")}
      onChange={(event) => changeLanguage(event.target.value)}
      className={`shrink-0 cursor-pointer rounded-full border px-3 py-1.5 text-xs font-semibold outline-none transition focus:ring-2 focus:ring-white/40 ${classes}`}
    >
      {LANGUAGES.map((language) => (
        <option key={language.code} value={language.code} lang={language.code}>
          {language.nativeName}
        </option>
      ))}
    </select>
  );
}

export default LanguageToggle;

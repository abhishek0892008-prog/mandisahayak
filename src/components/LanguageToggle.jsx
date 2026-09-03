import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";

/**
 * Language switch.
 *
 * When there is a session the choice is mirrored to `users.locale`, so the
 * server renders notifications in the language the farmer actually chose. The
 * local preference applies immediately either way.
 */
export function LanguageToggle({ variant = "onColour" }) {
  const { t, i18n } = useTranslation();
  const { changeLanguage } = useAuth();

  const shell =
    variant === "onColour"
      ? "bg-white/15"
      : "bg-slate-100";

  const activeClasses =
    variant === "onColour" ? "bg-white text-green-700" : "bg-green-700 text-white";

  const idleClasses = variant === "onColour" ? "text-white" : "text-slate-600";

  return (
    <div className={`flex shrink-0 items-center rounded-full p-1 ${shell}`}>
      {[
        ["en", t("english")],
        ["hi", t("hindi")],
      ].map(([code, label]) => (
        <button
          key={code}
          type="button"
          onClick={() => changeLanguage(code)}
          aria-pressed={i18n.language === code}
          className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
            i18n.language === code ? activeClasses : idleClasses
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default LanguageToggle;

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";
import { LANGUAGES } from "../lib/languages";

/**
 * First screen: choose a language.
 *
 * Every option is labelled in its own script, never in the language currently
 * active. Someone who opens the app in a language they cannot read has to be
 * able to find their own, and a list translated into the wrong language is
 * exactly the list they cannot use.
 *
 * Choosing here applies immediately and is persisted, so the rest of the app —
 * portal picker, sign-in, and every screen past it — renders in that language.
 */
function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const { changeLanguage } = useAuth();
  const navigate = useNavigate();

  async function choose(code) {
    await changeLanguage(code);
    navigate("/portal");
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f3f5f3]">
      <header className="bg-[#11a255] text-white">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6 lg:px-8">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-xl">
            🌾
          </span>

          <span className="text-lg font-extrabold tracking-tight">{t("appName")}</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
        <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
            {t("step1Of2")}
          </p>

          <h1 className="mt-3 text-2xl font-extrabold text-slate-900">
            {t("chooseLanguage")}
          </h1>

          {/* Shown in English as well as the active language, because this is
              the one screen where the active language may be unreadable. */}
          <p className="mt-2 text-sm leading-6 text-slate-500">
            {t("chooseLanguageDescription")}
            <span className="mt-1 block text-slate-400">Select your language to continue</span>
          </p>

          <ul className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {LANGUAGES.map((language) => {
              const selected = i18n.language === language.code;

              return (
                <li key={language.code}>
                  <button
                    type="button"
                    lang={language.code}
                    onClick={() => choose(language.code)}
                    aria-pressed={selected}
                    className={`w-full rounded-xl border-2 px-3 py-4 text-center transition ${
                      selected
                        ? "border-[#11a255] bg-emerald-50"
                        : "border-slate-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/40"
                    }`}
                  >
                    <span className="block text-base font-bold text-slate-900">
                      {language.nativeName}
                    </span>

                    <span className="mt-0.5 block text-xs font-medium text-slate-400">
                      {language.englishName}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={() => navigate("/portal")}
            className="mt-8 w-full rounded-xl bg-[#11a255] py-3.5 text-sm font-bold text-white transition hover:bg-[#0e8b49]"
          >
            {t("continue")} →
          </button>

          <p className="mt-4 text-center text-xs text-slate-400">
            {t("languageChangeableLater")}
          </p>
        </div>
      </main>
    </div>
  );
}

export default LanguageSelect;

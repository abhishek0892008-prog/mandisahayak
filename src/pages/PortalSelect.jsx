import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import LanguageToggle from "../components/LanguageToggle";

/**
 * Second screen: which portal.
 *
 * This only routes to a sign-in screen. It grants nothing and asserts nothing
 * about who the visitor is — picking "Officer" here just opens the staff
 * sign-in form, which still demands a password and a second factor, and the
 * server decides the rest.
 */
function PortalSelect() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const options = [
    {
      key: "farmer",
      icon: "🌾",
      title: t("iAmFarmer"),
      subtitle: t("farmer"),
      description: t("farmerPortalDescription"),
      to: "/login",
    },
    {
      key: "officer",
      icon: "🏛️",
      title: t("iAmOfficer"),
      subtitle: t("officer"),
      description: t("officerPortalDescription"),
      to: "/staff-login",
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-[#f3f5f3]">
      <header className="bg-[#11a255] text-white">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1280px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-xl">
              🌾
            </span>

            <span className="text-lg font-extrabold tracking-tight">{t("appName")}</span>
          </div>

          <LanguageToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <div className="rounded-2xl bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
            {t("step2Of2")}
          </p>

          <h1 className="mt-3 text-2xl font-extrabold text-slate-900">{t("whoAreYou")}</h1>

          <p className="mt-2 text-sm leading-6 text-slate-500">{t("whoAreYouDescription")}</p>

          {/* Same tile grid as the language chooser, so the two entry steps
              read as one flow rather than two unrelated screens. */}
          <ul className="mt-7 grid grid-cols-2 gap-3">
            {options.map((option) => (
              <li key={option.key}>
                <button
                  type="button"
                  onClick={() => navigate(option.to)}
                  className="flex h-full w-full flex-col items-center rounded-xl border-2 border-slate-200 bg-white px-3 py-6 text-center transition hover:border-emerald-300 hover:bg-emerald-50/40"
                >
                  <span className="text-3xl">{option.icon}</span>

                  <span className="mt-3 block text-base font-bold text-slate-900">
                    {option.title}
                  </span>

                  <span className="mt-0.5 block text-xs font-medium text-slate-400">
                    {option.subtitle}
                  </span>

                  <span className="mt-3 block text-xs leading-5 text-slate-500">
                    {option.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => navigate("/")}
            className="mt-6 text-sm font-bold text-emerald-700 hover:underline"
          >
            ← {t("changeLanguage")}
          </button>
        </div>
      </main>
    </div>
  );
}

export default PortalSelect;

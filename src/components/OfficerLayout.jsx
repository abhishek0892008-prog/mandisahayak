import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";
import LanguageToggle from "./LanguageToggle";

const NAV_ITEMS = [
  { to: "/officer", end: true, key: "officerToday" },
  { to: "/officer/gate", key: "gateEntry" },
  { to: "/officer/weighment", key: "weighment" },
  { to: "/officer/payments", key: "payments" },
  { to: "/officer/reports", key: "reports" },
];

/**
 * The officer shell.
 *
 * Keeps the emerald layout from the original prototype — the visual design was
 * good and there was no reason to replace it — but the numbers in the sidebar
 * are passed in by each screen from server data rather than computed from a
 * local array.
 */
export function OfficerLayout({ title, subtitle, stats = [], children, actions }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { farmer, signOut } = useAuth();

  const navClass = ({ isActive }) =>
    [
      "flex shrink-0 items-center justify-center rounded-full border px-3 py-2 text-sm font-semibold transition sm:px-4",
      isActive
        ? "border-white/50 bg-white text-emerald-900 shadow-lg shadow-emerald-950/10"
        : "border-white/25 bg-white/10 text-white hover:bg-white/20",
    ].join(" ");

  async function handleSignOut() {
    await signOut();
    navigate("/staff-login", { replace: true });
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f3f5f3] text-slate-900">
      <div className="mx-auto min-w-0 max-w-[1280px]">
        <div className="bg-[#11a255] px-4 py-4 text-white sm:px-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-black uppercase tracking-[0.18em] text-white">
                {t("appName")}
              </p>

              <p className="truncate text-xs text-emerald-50">
                {farmer?.fullName} · {t("officer")}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <LanguageToggle />

              <button
                type="button"
                onClick={handleSignOut}
                className="rounded-full border border-white/25 bg-white/10 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/20"
              >
                {t("signOut")}
              </button>
            </div>
          </div>

          <nav className="flex flex-nowrap gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {t(item.key)}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="mt-4 grid min-w-0 gap-4 px-4 pb-6 lg:mt-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-5 lg:px-6">
          <aside className="rounded-[28px] border border-emerald-200 bg-white/90 p-3 shadow-[0_8px_24px_rgba(16,64,42,0.08)] sm:p-4">
            <div className="grid grid-cols-2 gap-3 lg:block lg:space-y-3">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className={`rounded-2xl border border-emerald-100 p-4 ${stat.tone ?? "bg-emerald-50/60"}`}
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-800/80">
                    {stat.label}
                  </p>

                  <p className="mt-2 text-3xl font-black text-slate-900">{stat.value}</p>
                </div>
              ))}
            </div>
          </aside>

          <main className="min-w-0 rounded-[30px] border border-[#e7e7e7] bg-[#fafafa] p-3 shadow-[0_8px_18px_rgba(15,25,20,0.04)] sm:p-4 lg:p-6">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                {subtitle && (
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                    {subtitle}
                  </p>
                )}

                <h2 className="text-2xl font-black text-slate-900 sm:text-3xl">{title}</h2>
              </div>

              {actions}
            </div>

            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export default OfficerLayout;

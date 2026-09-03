import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";

export function NotFound() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 text-3xl">
          🧭
        </div>

        <h1 className="mt-5 text-xl font-bold text-slate-900">{t("pageNotFound")}</h1>

        <p className="mt-2 text-sm leading-5 text-slate-500">{t("pageNotFoundDescription")}</p>

        <button
          type="button"
          onClick={() => navigate(isAuthenticated ? "/dashboard" : "/login", { replace: true })}
          className="mt-6 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-800"
        >
          {isAuthenticated ? t("goToDashboard") : t("loginLink")}
        </button>
      </div>
    </div>
  );
}

export default NotFound;

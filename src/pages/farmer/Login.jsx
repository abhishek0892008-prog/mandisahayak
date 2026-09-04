import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateFieldErrors } from "../../lib/codes";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [phone, setPhone] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!/^[6-9]\d{9}$/.test(phone)) {
      setFieldError(
        t("codes.fieldErrors.PHONE_INVALID_INDIAN_MOBILE"),
      );
      return;
    }

    setSubmitting(true);
    setFieldError(null);
    setSubmitError(null);

    try {
      const challenge = await api.loginStartOtp(phone);

      navigate("/verify-otp", {
        replace: true,
        state: {
          challenge,
          phone,
          purpose: "login",
        },
      });
    } catch (error) {
      const fields = translateFieldErrors(t, error);

      if (fields.phone) {
        setFieldError(fields.phone);
      } else {
        setSubmitError(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f3f5f3] text-slate-900">
      <header className="bg-[#11a255] text-white">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1280px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => navigate("/portal")}
            className="flex items-center gap-3 text-left"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-xl">
              🌾
            </span>

            <span>
              <span className="block text-lg font-extrabold tracking-tight">
                {t("appName")}
              </span>

              <span className="hidden text-xs font-medium text-white/80 sm:block">
                Farmer Procurement Portal
              </span>
            </span>
          </button>

          <div className="flex items-center gap-2 sm:gap-3">
            <LanguageToggle />

            <button
              type="button"
              onClick={() => navigate("/staff-login")}
              className="rounded-full border border-white/30 bg-white/10 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/20"
            >
              {t("staffLogin")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-72px)] w-full max-w-[1280px] items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <section className="w-full max-w-[500px]">
          <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-7 shadow-[0_8px_30px_rgba(16,64,42,0.06)] sm:px-8 sm:py-9 lg:px-10 lg:py-10">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-2xl">
                🌾
              </div>

              <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                {t("farmer")} {t("login")}
              </p>

              <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                {t("welcome")}
              </h1>

              <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
                {t("enterMobileToContinue") ||
                  "Enter your registered mobile number to continue to your FarmQueue account."}
              </p>
            </div>

            {submitError && (
              <div className="mt-6">
                <ErrorState
                  error={submitError}
                  onRetry={() => setSubmitError(null)}
                />
              </div>
            )}

            <form
              className="mt-8"
              onSubmit={handleSubmit}
              noValidate
            >
              <div>
                <label
                  htmlFor="phone"
                  className="mb-2 block text-sm font-bold text-slate-700"
                >
                  {t("mobileNumber")}
                </label>

                <div
                  className={`flex overflow-hidden rounded-xl border bg-white transition focus-within:ring-4 focus-within:ring-emerald-50 ${
                    fieldError
                      ? "border-red-400 focus-within:border-red-500"
                      : "border-slate-200 focus-within:border-emerald-500"
                  }`}
                >
                  <span className="flex min-h-14 items-center border-r border-slate-200 bg-slate-50 px-4 text-sm font-bold text-slate-600">
                    +91
                  </span>

                  <input
                    id="phone"
                    type="tel"
                    name="phone"
                    value={phone}
                    maxLength={10}
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder={t("mobileNumberPlaceholder")}
                    onChange={(event) => {
                      setPhone(
                        event.target.value
                          .replace(/\D/g, "")
                          .slice(0, 10),
                      );
                      setFieldError(null);
                    }}
                    className="min-h-14 min-w-0 flex-1 bg-white px-4 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                  />
                </div>

                {fieldError ? (
                  <p className="mt-2 text-xs text-red-500">
                    {fieldError}
                  </p>
                ) : (
                  <p className="mt-2 text-xs leading-5 text-slate-400">
                    {t("otpWillBeSent")}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 flex min-h-14 w-full items-center justify-center rounded-xl bg-[#15803d] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#166534] disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
              >
                {submitting
                  ? t("sendingOtp")
                  : `${t("continueToOtp")} →`}
              </button>
            </form>

            <div className="my-7 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />

              <span className="text-xs font-medium text-slate-400">
                {t("noAccount")}
              </span>

              <div className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={() => navigate("/register")}
              className="flex min-h-12 w-full items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 px-5 text-sm font-bold text-[#15803d] transition hover:bg-emerald-100"
            >
              {t("registerAsFarmer")}
            </button>

            <p className="mt-5 text-center text-sm text-slate-500">
              <button
                type="button"
                onClick={() => navigate("/staff-login")}
                className="font-bold text-emerald-700 hover:underline"
              >
                {t("staffLogin")}
              </button>
            </p>

            <div className="mt-7 border-t border-slate-100 pt-5 text-center">
              <p className="text-xs leading-5 text-slate-400">
                {t("secureProcurement")}
              </p>
            </div>
          </div>

          <p className="mt-5 text-center text-xs font-medium text-slate-400">
            {t("secureProcurement")}
          </p>
        </section>
      </main>
    </div>
  );
}

export default Login;
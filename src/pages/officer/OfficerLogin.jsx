import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateFieldErrors } from "../../lib/codes";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

/**
 * Staff sign-in.
 *
 * The phone number is the WHOLE credential: there is no password step. The
 * server answers with an OTP challenge, and that OTP goes through the same
 * `/auth/otp/verify` a farmer uses, so this screen hands the challenge to the
 * shared OTP screen rather than duplicating it.
 *
 * `INVALID_CREDENTIALS` is returned for an unknown number, a non-staff account
 * and an inactive one alike. The UI must not try to tell them apart, and does
 * not — distinguishing them would confirm which numbers belong to staff.
 */
function OfficerLogin() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [phone, setPhone] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!/^[6-9]\d{9}$/.test(phone)) {
      setFieldError(t("codes.fieldErrors.PHONE_INVALID_INDIAN_MOBILE"));
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldError(null);

    try {
      const challenge = await api.staffLogin(phone);

      navigate("/verify-otp", {
        replace: true,
        state: { challenge, purpose: "staff", phone },
      });
    } catch (loginError) {
      const fields = translateFieldErrors(t, loginError);

      if (fields.phone) {
        setFieldError(fields.phone);
      } else {
        setError(loginError);
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
              🏛️
            </span>

            <span>
              <span className="block text-lg font-extrabold tracking-tight">
                FarmQueue
              </span>

              <span className="hidden text-xs font-medium text-white/80 sm:block">
                {t("staffPortal")}
              </span>
            </span>
          </button>

          <div className="flex items-center gap-2 sm:gap-3">
            <LanguageToggle />

            <button
              type="button"
              onClick={() => navigate("/login")}
              className="rounded-full border border-white/30 bg-white px-4 py-2 text-sm font-bold text-[#0b7f43] transition hover:bg-white/90"
            >
              {t("farmerLogin")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-72px)] w-full max-w-[1280px] items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <section className="w-full max-w-[500px]">
          <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-7 shadow-[0_8px_30px_rgba(16,64,42,0.06)] sm:px-8 sm:py-9 lg:px-10 lg:py-10">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-2xl">
                🏛️
              </div>

              <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                {t("staffLogin")}
              </p>

              <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                {t("welcomeBack")}
              </h1>

              <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
                {t("enterMobileToContinue") ||
                  "Use your registered mobile number to receive an OTP."}
              </p>
            </div>

            {error && (
              <div className="mt-6">
                <ErrorState error={error} onRetry={() => setError(null)} />
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-8" noValidate>
              <div>
                <label
                  htmlFor="phone"
                  className="mb-2 block text-sm font-bold text-slate-700"
                >
                  {t("mobileNumber")}
                </label>

                <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-50">
                  <span className="flex min-h-13 items-center border-r border-slate-200 bg-slate-50 px-4 text-sm font-bold text-slate-600">
                    +91
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    maxLength={10}
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder={t("mobileNumberPlaceholder")}
                    onChange={(event) => {
                      setPhone(
                        event.target.value.replace(/\D/g, "").slice(0, 10),
                      );
                      setFieldError(null);
                    }}
                    className="min-h-13 min-w-0 flex-1 bg-white px-4 text-sm outline-none"
                  />
                </div>
                {fieldError && (
                  <p className="mt-2 text-xs text-red-500">{fieldError}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="min-h-13 w-full rounded-xl bg-[#11a255] text-sm font-bold text-white transition hover:bg-[#0e8b49] disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {submitting ? t("verifying") : `${t("continueToOtp")} →`}
              </button>

              <p className="mt-3 text-center text-xs leading-5 text-slate-400">
                {t("otpWillBeSent")}
              </p>
            </form>

            <div className="mt-7 border-t border-slate-100 pt-5 text-center">
              <p className="text-sm text-slate-500">
                {t("noOfficerAccount")}{" "}
                <button
                  type="button"
                  onClick={() => navigate("/staff-register")}
                  className="font-bold text-emerald-700 hover:underline"
                >
                  {t("applyForAccount")}
                </button>
              </p>

              <p className="mt-3 text-sm text-slate-500">
                {t("areYouFarmer")}{" "}
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="font-bold text-emerald-700 hover:underline"
                >
                  {t("farmerLogin")}
                </button>
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default OfficerLogin;

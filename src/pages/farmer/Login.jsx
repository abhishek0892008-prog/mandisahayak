import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateFieldErrors } from "../../lib/codes";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

/**
 * Farmer login.
 *
 * The prototype held the number nowhere and navigated to the OTP screen on a
 * button press. Here the number is state, it is submitted, and the challenge
 * the server returns is what the OTP screen verifies against.
 *
 * The response is deliberately identical for a registered and an unregistered
 * number (authentication.md §2.2), so this screen must not — and does not —
 * tell the user which they are.
 */
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
      setFieldError(t("codes.fieldErrors.PHONE_INVALID_INDIAN_MOBILE"));
      return;
    }

    setSubmitting(true);
    setFieldError(null);
    setSubmitError(null);

    try {
      const challenge = await api.loginStartOtp(phone);

      navigate("/verify-otp", {
        replace: true,
        state: { challenge, phone, purpose: "login" },
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
    <div className="min-h-screen bg-green-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg p-6">
        <div className="flex justify-end">
          <LanguageToggle variant="onLight" />
        </div>

        <div className="flex justify-center mb-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-700 text-2xl shadow-sm">
            🌾
          </div>
        </div>

        <h1 className="text-2xl font-bold text-green-800 text-center">{t("appName")}</h1>

        <p className="text-center text-gray-500 mt-1">{t("farmerProcurementPortal")}</p>

        <div className="mt-8">
          <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">
            {t("farmerLogin")}
          </p>

          <h2 className="text-xl font-semibold text-gray-900 mt-3">{t("welcomeBack")}</h2>

          <p className="text-sm text-gray-500 mt-1 mb-6">{t("loginDescription")}</p>

          {submitError && (
            <ErrorState
              error={submitError}
              className="mb-4"
              onRetry={() => setSubmitError(null)}
            />
          )}

          <form className="space-y-5" onSubmit={handleSubmit} noValidate>
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                {t("mobileNumber")}
              </label>

              <div className="flex">
                <span className="bg-gray-100 border border-gray-200 border-r-0 p-3 rounded-l-lg text-gray-600">
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
                    setPhone(event.target.value.replace(/\D/g, "").slice(0, 10));
                    setFieldError(null);
                  }}
                  className={`flex-1 border rounded-r-lg p-3 bg-gray-50 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100 ${
                    fieldError ? "border-red-400" : "border-gray-200"
                  }`}
                />
              </div>

              {fieldError ? (
                <p className="text-xs text-red-500 mt-1.5">{fieldError}</p>
              ) : (
                <p className="text-xs text-gray-400 mt-1.5">{t("otpWillBeSent")}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-green-700 hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-300 text-white font-semibold py-3 rounded-lg transition"
            >
              {submitting ? t("sendingOtp") : `${t("continueToOtp")} →`}
            </button>
          </form>

          <div className="text-center mt-6">
            <p className="text-sm text-gray-500">{t("noAccount")}</p>

            <button
              type="button"
              onClick={() => navigate("/")}
              className="text-sm text-green-700 font-semibold hover:underline mt-1"
            >
              {t("registerAsFarmer")}
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">{t("secureProcurement")}</p>
      </div>
    </div>
  );
}

export default Login;

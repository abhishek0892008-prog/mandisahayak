import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateFieldErrors } from "../../lib/codes";
import { ErrorState } from "../../components/StateViews";

/**
 * Staff sign-in, first factor.
 *
 * The password creates NO session — it returns an OTP challenge, and the
 * second factor goes through the same `/auth/otp/verify` a farmer uses
 * (authentication.md §2.3). So this screen hands the challenge to the shared
 * OTP screen rather than duplicating it.
 *
 * `INVALID_CREDENTIALS` is returned for a wrong password, an unknown user, a
 * non-staff account and an inactive one alike. The UI must not try to tell
 * them apart, and does not.
 */
function OfficerLogin() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!username.trim() || !password) {
      setFieldErrors({
        username: username.trim() ? undefined : t("codes.fieldErrors.USERNAME_INVALID"),
        password: password ? undefined : t("codes.fieldErrors.PASSWORD_REQUIRED"),
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      const challenge = await api.staffLogin(username.trim(), password);

      navigate("/verify-otp", {
        replace: true,
        state: { challenge, purpose: "staff", username: username.trim() },
      });
    } catch (loginError) {
      const fields = translateFieldErrors(t, loginError);

      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(loginError);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const control =
    "w-full rounded-lg border border-gray-200 bg-gray-50 p-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

  return (
    <div className="flex min-h-screen items-center justify-center bg-emerald-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg">
        <div className="mb-3 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-700 text-2xl shadow-sm">
            🏛️
          </div>
        </div>

        <h1 className="text-center text-2xl font-bold text-emerald-800">{t("appName")}</h1>

        <p className="mt-1 text-center text-gray-500">{t("staffPortal")}</p>

        <div className="mt-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            {t("staffLogin")}
          </p>

          <h2 className="mt-3 text-xl font-semibold text-gray-900">{t("welcomeBack")}</h2>

          <p className="mb-6 mt-1 text-sm text-gray-500">{t("staffLoginDescription")}</p>
        </div>

        {error && <ErrorState error={error} className="mb-4" onRetry={() => setError(null)} />}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="username" className="mb-1 block text-sm font-medium text-gray-700">
              {t("employeeCode")}
            </label>

            <input
              id="username"
              type="text"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
              className={control}
            />

            {fieldErrors.username && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.username}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
              {t("password")}
            </label>

            <input
              id="password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              className={control}
            />

            {fieldErrors.password && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.password}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-700 py-3 font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-300"
          >
            {submitting ? t("verifying") : `${t("continueToOtp")} →`}
          </button>

          {/* Said plainly, because a password box that silently needs a second
              step is a support call waiting to happen. */}
          <p className="text-center text-xs text-gray-400">{t("staffTwoFactorNote")}</p>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          {t("areYouFarmer")}{" "}
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="font-semibold text-emerald-700 hover:underline"
          >
            {t("farmerLogin")}
          </button>
        </p>
      </div>
    </div>
  );
}

export default OfficerLogin;

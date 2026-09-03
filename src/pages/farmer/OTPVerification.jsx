import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { DEMO_OTP_ENABLED } from "../../lib/api";
import { useAuth } from "../../auth/context";
import { translateError } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import LanguageToggle from "../../components/LanguageToggle";

const OTP_LENGTH = 6;

function secondsUntil(iso, now) {
  if (!iso) return 0;

  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;

  return Math.max(0, Math.ceil((target - now) / 1000));
}

/**
 * OTP verification.
 *
 * The prototype's "Verify & Continue" navigated to the dashboard without
 * calling anything — any six digits worked. Here nothing proceeds without a
 * `201` from `POST /auth/otp/verify`, which is what actually creates the
 * session cookie.
 *
 * Expiry and resend cooldown are driven by the timestamps the server returned
 * (`expiresAt`, `resendAvailableAt`) rather than a hardcoded 30-second counter,
 * so the UI cannot disagree with the server about when a code dies.
 */
function OTPVerification() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { onSignedIn } = useAuth();

  const initial = location.state ?? null;

  const [challenge, setChallenge] = useState(initial?.challenge ?? null);
  const [digits, setDigits] = useState(Array(OTP_LENGTH).fill(""));
  const [error, setError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const inputRefs = useRef([]);

  // One ticking clock drives both countdowns; setState in a timer callback is
  // not a synchronous effect update, so it stays clear of cascading renders.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expiresIn = secondsUntil(challenge?.expiresAt, now);
  const resendIn = secondsUntil(challenge?.resendAvailableAt, now);

  const phone = initial?.phone ?? "";

  const maskedPhone = useMemo(() => {
    if (!phone) return "+91 XXXXX XXXXX";
    return `+91 ${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`;
  }, [phone]);

  // Demo mode only. Re-requested whenever a new challenge is issued, so a
  // resend shows the new code rather than the stale one.
  const demoOtp = useApiResource(
    (signal) => api.devLastOtp(phone, signal),
    [phone, challenge?.challengeId],
    { enabled: DEMO_OTP_ENABLED && Boolean(phone) },
  );

  // A refresh loses the router state, and the challenge exists nowhere else by
  // design. Sending the farmer back to request a new code is the honest
  // recovery; there is nothing to restore.
  if (!challenge) {
    return <Navigate to="/login" replace state={{ notice: "otpSessionMissing" }} />;
  }

  function setDigit(index, value) {
    if (!/^\d?$/.test(value)) return;

    setError(null);
    setLocalError(null);

    setDigits((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });

    if (value && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(event, index) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(event) {
    event.preventDefault();

    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (!pasted) return;

    const next = Array(OTP_LENGTH).fill("");
    pasted.split("").forEach((digit, index) => {
      next[index] = digit;
    });

    setDigits(next);
    setError(null);
    setLocalError(null);

    inputRefs.current[Math.min(pasted.length, OTP_LENGTH - 1)]?.focus();
  }

  async function handleVerify() {
    const otp = digits.join("");

    if (otp.length !== OTP_LENGTH) {
      setLocalError(t("enterCompleteOtp"));
      return;
    }

    setSubmitting(true);
    setError(null);
    setLocalError(null);

    try {
      await api.verifyOtp(challenge.challengeId, otp);

      // The cookie now exists. Resolving the session from GET /me is what
      // makes the app consider the farmer signed in.
      await onSignedIn();
      navigate("/dashboard", { replace: true });
    } catch (verifyError) {
      setError(verifyError);
      setDigits(Array(OTP_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (resendIn > 0 || resending) return;

    setResending(true);
    setError(null);
    setLocalError(null);

    try {
      const next = await api.resendOtp(challenge.challengeId);

      // A resend issues a new code and a new cooldown, but does NOT reset the
      // attempt budget (authentication.md §2.5).
      setChallenge(next);
      setDigits(Array(OTP_LENGTH).fill(""));
      inputRefs.current[0]?.focus();
    } catch (resendError) {
      setError(resendError);
    } finally {
      setResending(false);
    }
  }

  const expired = expiresIn <= 0;
  const shownError = localError ?? (error ? translateError(t, error) : null);

  return (
    <div className="min-h-screen bg-green-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl p-6 sm:p-8">
        <div className="flex justify-end">
          <LanguageToggle variant="onLight" />
        </div>

        <div className="flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-700 text-2xl shadow-sm">
            🌾
          </div>
        </div>

        <h1 className="mt-3 text-2xl font-bold text-green-800 text-center">{t("appName")}</h1>

        <p className="text-center text-gray-500 mt-1 text-sm">{t("farmerProcurementPortal")}</p>

        <div className="mt-8">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">
              {t("stepOf", { current: 2, total: 2 })}
            </span>

            <span className="text-xs text-gray-400">{t("verificationStepLabel")}</span>
          </div>

          <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="w-full h-full bg-green-700 rounded-full" />
          </div>
        </div>

        <div className="text-center mt-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-xl">
            📱
          </div>

          <h2 className="text-xl font-semibold text-gray-900 mt-4">{t("verifyMobileNumber")}</h2>

          <p className="text-sm text-gray-500 mt-2">{t("otpSentTo")}</p>

          <p className="text-sm font-semibold text-gray-800 mt-1">{maskedPhone}</p>
        </div>

        <div className="flex justify-center gap-2 sm:gap-3 mt-7" onPaste={handlePaste}>
          {digits.map((digit, index) => (
            <input
              // Positional inputs of fixed length; the index IS the identity.
              key={index}
              ref={(element) => {
                inputRefs.current[index] = element;
              }}
              type="text"
              value={digit}
              maxLength={1}
              inputMode="numeric"
              disabled={submitting || expired}
              aria-label={`${t("otpDigit")} ${index + 1}`}
              autoComplete={index === 0 ? "one-time-code" : "off"}
              onChange={(event) => setDigit(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`w-11 h-12 sm:w-12 sm:h-13 text-center text-lg font-semibold border rounded-xl bg-gray-50 outline-none transition disabled:opacity-50 ${
                shownError
                  ? "border-red-300 focus:border-red-500 focus:ring-2 focus:ring-red-100"
                  : "border-gray-200 focus:border-green-600 focus:ring-2 focus:ring-green-100"
              }`}
            />
          ))}
        </div>

        {shownError && <p className="text-center text-xs text-red-600 mt-3">{shownError}</p>}

        {/*
          Demo mode only. No SMS provider is configured, so the code is shown
          here instead of arriving on a phone. It is still submitted to
          /auth/otp/verify like any other code — this reveals the OTP, it does
          not skip verification.
        */}
        {DEMO_OTP_ENABLED && demoOtp.data && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
              {t("demoOtpLabel")}
            </p>

            <p className="mt-1 font-mono text-2xl font-bold tracking-[0.3em] text-amber-900">
              {demoOtp.data}
            </p>

            <button
              type="button"
              onClick={() => {
                setDigits(demoOtp.data.padEnd(OTP_LENGTH, "").slice(0, OTP_LENGTH).split(""));
                setError(null);
                setLocalError(null);
              }}
              className="mt-2 text-xs font-semibold text-amber-800 underline"
            >
              {t("demoOtpFill")}
            </button>

            <p className="mt-2 text-[11px] leading-4 text-amber-700">{t("demoOtpNote")}</p>
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-3">
          {expired ? t("otpExpired") : t("otpExpiresIn", { seconds: expiresIn })}
        </p>

        {typeof challenge.attemptsRemaining === "number" && (
          <p className="text-center text-xs text-gray-400 mt-1">
            {t("attemptsRemaining", { count: challenge.attemptsRemaining })}
          </p>
        )}

        <div className="text-center mt-6">
          <p className="text-sm text-gray-500">{t("didntReceiveOtp")}</p>

          {resendIn > 0 ? (
            <p className="mt-1 text-sm font-semibold text-gray-400">
              {t("resendOtpIn", { seconds: resendIn })}
            </p>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="mt-1 text-sm font-semibold text-green-700 hover:underline disabled:text-gray-400"
            >
              {resending ? t("sendingOtp") : t("resendOtp")}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={handleVerify}
          disabled={submitting || expired}
          className="w-full bg-green-700 hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-300 text-white font-semibold py-3.5 rounded-xl transition mt-6 shadow-sm"
        >
          {submitting ? t("verifying") : `${t("verifyAndContinue")} →`}
        </button>

        <button
          type="button"
          onClick={() => navigate(initial?.purpose === "register" ? "/" : "/login", { replace: true })}
          className="w-full text-sm text-gray-500 hover:text-green-700 mt-4"
        >
          ← {t("changeMobileNumber")}
        </button>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-gray-400">
          <span>🔒</span>
          <span>{t("secureVerification")}</span>
        </div>
      </div>
    </div>
  );
}

export default OTPVerification;

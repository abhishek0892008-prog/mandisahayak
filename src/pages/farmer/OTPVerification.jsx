import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { DEMO_OTP_ENABLED } from "../../lib/api";
import { useAuth } from "../../auth/context";
import { translateError } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import { homePathFor } from "../../auth/roles";
import LanguageToggle from "../../components/LanguageToggle";

/**
 * Only a fallback. The real length comes from the server on every challenge
 * (`otpLength`), so the number of boxes follows OTP_LENGTH in the backend
 * config and is never a second, drifting definition on the client. This value
 * is used solely if a challenge somehow arrives without the field.
 */
const FALLBACK_OTP_LENGTH = 4;

function secondsUntil(iso, now) {
  if (!iso) return 0;

  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;

  return Math.max(0, Math.ceil((target - now) / 1000));
}

function OTPVerification() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { onSignedIn } = useAuth();

  const initial = location.state ?? null;

  const [challenge, setChallenge] = useState(initial?.challenge ?? null);

  // The server dictates how many digits it issued; the UI renders that many.
  const otpLength = challenge?.otpLength ?? FALLBACK_OTP_LENGTH;

  const [digits, setDigits] = useState(() =>
    Array(initial?.challenge?.otpLength ?? FALLBACK_OTP_LENGTH).fill(""),
  );
  const [error, setError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const inputRefs = useRef([]);

  /*
   * Guards re-entry into verification: the auto-submit fires from a keystroke
   * and the button fires from a click, and both can land before `submitting`
   * has re-rendered. Without it a fast typist can spend two of the five
   * attempts on a single code.
   */
  const verifyingRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const expiresIn = secondsUntil(challenge?.expiresAt, now);
  const resendIn = secondsUntil(challenge?.resendAvailableAt, now);

  const phone = initial?.phone ?? "";
  const isStaff = initial?.purpose === "staff";

  const maskedPhone = useMemo(() => {
    if (!phone) return "+91 XXXXX XXXXX";

    return `+91 ${phone.slice(0, 2)}XXXXXX${phone.slice(-2)}`;
  }, [phone]);

  /*
   * The demo code, from the challenge the server just issued.
   *
   * `devOtp` is present only when the backend runs with DEMO_MODE, and it is
   * the EXACT code that backend generated — never a second one invented here.
   * A resend returns a fresh challenge, so this follows the new code.
   */
  const demoOtp = useApiResource(
    (signal) => api.devLastOtp(phone, signal),
    /*
     * `expiresAt`, not just `challengeId`: a RESEND reuses the same challenge
     * row and therefore the same id, so keying on the id alone left this
     * showing the superseded code — the farmer typed what was on screen and
     * was told it was wrong. `expiresAt` moves on every resend.
     */
    [phone, challenge?.challengeId, challenge?.expiresAt],
    {
      // Fallback only: the token-protected lookup still works for setups that
      // predate `devOtp`, and is skipped entirely once the challenge carries it.
      enabled: DEMO_OTP_ENABLED && Boolean(phone) && !challenge?.devOtp,
    },
  );

  const demoOtpCode =
    challenge?.devOtp ?? (DEMO_OTP_ENABLED ? demoOtp.data : null);
  const demoOtpUnavailable =
    DEMO_OTP_ENABLED &&
    !challenge?.devOtp &&
    !demoOtp.loading &&
    demoOtp.data === null;

  if (!challenge) {
    return (
      <Navigate
        to={isStaff ? "/staff-login" : "/login"}
        replace
        state={{ notice: "otpSessionMissing" }}
      />
    );
  }

  function setDigit(index, value) {
    if (!/^\d?$/.test(value)) return;

    setError(null);
    setLocalError(null);

    // Built outside the updater so the completed code is available now; an
    // updater must stay pure, and StrictMode double-invokes it.
    const next = [...digits];
    next[index] = value;
    commitDigits(next);

    if (value && index < otpLength - 1) {
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

    const pasted = event.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, otpLength);

    if (!pasted) return;

    const next = Array(otpLength).fill("");

    pasted.split("").forEach((digit, index) => {
      next[index] = digit;
    });

    setError(null);
    setLocalError(null);
    commitDigits(next);

    inputRefs.current[Math.min(pasted.length, otpLength - 1)]?.focus();
  }

  /*
   * Submits one code. Takes the code as an argument rather than reading
   * `digits`, so the last keystroke can submit the value it just produced
   * without waiting a render for state to catch up.
   */
  async function verifyWith(otp) {
    if (verifyingRef.current) return;

    if (otp.length !== otpLength) {
      setLocalError(t("enterCompleteOtp", { digits: otpLength }));
      return;
    }

    verifyingRef.current = true;
    setSubmitting(true);
    setError(null);
    setLocalError(null);

    try {
      await api.verifyOtp(challenge.challengeId, otp);

      const profile = await onSignedIn();

      navigate(homePathFor(profile), {
        replace: true,
      });
    } catch (verifyError) {
      setError(verifyError);
      // Clearing the boxes is also what stops the auto-submit from firing
      // again on the same rejected code.
      setDigits(Array(otpLength).fill(""));
      inputRefs.current[0]?.focus();
    } finally {
      verifyingRef.current = false;
      setSubmitting(false);
    }
  }

  function handleVerify() {
    return verifyWith(digits.join(""));
  }

  /**
   * Submits as soon as the last digit lands, so the farmer is not left on a
   * filled-in screen wondering what to press. The button stays for anyone who
   * clears a box and retypes it, and for assistive tech.
   */
  function commitDigits(next) {
    setDigits(next);
    if (next.length === otpLength && next.every((d) => d !== "") && !expired) {
      verifyWith(next.join(""));
    }
  }

  async function handleResend() {
    if (resendIn > 0 || resending) return;

    setResending(true);
    setError(null);
    setLocalError(null);

    try {
      const next = await api.resendOtp(challenge.challengeId);

      setChallenge(next);
      setDigits(Array(otpLength).fill(""));
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
    <div className="min-h-screen bg-[#f3f5f3] text-slate-900">
      <header className="border-b border-emerald-700/20 bg-[#11a255] text-white">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1280px] items-center justify-between px-4 sm:px-6 lg:px-8">
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
                Mandi Sahayak
              </span>

              <span className="hidden text-xs font-medium text-white/80 sm:block">
                {t("farmerProcurementPortal")}
              </span>
            </span>
          </button>

          <div className="flex items-center gap-2 sm:gap-3">
            <LanguageToggle variant="onGreen" />

            <span className="hidden rounded-full border border-white/25 bg-white/10 px-4 py-2 text-xs font-semibold sm:block">
              {t("secureVerification")}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-72px)] w-full max-w-[1280px] items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <section className="w-full max-w-[500px]">
          <div className="rounded-[24px] border border-slate-200 bg-white px-5 py-7 shadow-[0_8px_30px_rgba(16,64,42,0.06)] sm:px-8 sm:py-9 lg:px-10 lg:py-10">
            <div className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-2xl">
                📱
              </div>

              <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
                {t("verificationStepLabel")}
              </p>

              <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
                {t("verifyMobileNumber")}
              </h1>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {t("otpSentTo", { digits: otpLength })}
              </p>

              <p className="mt-1 text-sm font-extrabold text-slate-800">
                {maskedPhone}
              </p>
            </div>

            <div className="mt-8">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-[0.12em] text-emerald-700">
                  {t("stepOf", { current: 2, total: 2 })}
                </span>

                <span className="text-xs font-medium text-slate-400">
                  {t("verificationStepLabel")}
                </span>
              </div>

              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-full rounded-full bg-[#11a255]" />
              </div>
            </div>

            {demoOtpCode && (
              <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-3 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                  {t("demoOtpLabel")}
                </p>

                <p className="mt-1 font-mono text-3xl font-bold tracking-[0.3em] text-amber-900">
                  {demoOtpCode}
                </p>

                <p className="mt-2 text-[11px] leading-4 text-amber-700">
                  {t("demoOtpNote")}
                </p>

                {/*
                  A convenience, not an auto-fill: the boxes stay empty until
                  someone taps this, so the normal typing path is what the demo
                  actually exercises.
                */}
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setLocalError(null);
                    commitDigits(
                      demoOtpCode
                        .padEnd(otpLength, "")
                        .slice(0, otpLength)
                        .split(""),
                    );
                  }}
                  className="mt-2 text-xs font-semibold text-amber-800 underline"
                >
                  {t("demoOtpFill")}
                </button>
              </div>
            )}

            {demoOtpUnavailable && (
              <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                <p className="text-xs font-semibold text-slate-600">
                  {t("demoOtpUnavailable")}
                </p>
              </div>
            )}

            <div
              className="mt-8 flex justify-center gap-2 sm:gap-3"
              onPaste={handlePaste}
            >
              {digits.map((digit, index) => (
                <input
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
                  className={`h-12 w-11 rounded-xl border bg-white text-center text-lg font-extrabold outline-none transition sm:h-14 sm:w-14 ${
                    shownError
                      ? "border-red-300 focus:border-red-500 focus:ring-4 focus:ring-red-50"
                      : "border-slate-200 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-50"
                  }`}
                />
              ))}
            </div>

            {shownError && (
              <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-center">
                <p className="text-xs font-semibold text-red-600">
                  {shownError}
                </p>
              </div>
            )}

            <p className="mt-3 text-center text-xs text-slate-400">
              {expired
                ? t("otpExpired")
                : t("otpExpiresIn", {
                    seconds: expiresIn,
                  })}
            </p>

            {typeof challenge.attemptsRemaining === "number" && (
              <p className="mt-1 text-center text-xs text-slate-400">
                {t("attemptsRemaining", {
                  count: challenge.attemptsRemaining,
                })}
              </p>
            )}

            <div className="mt-7 text-center">
              <p className="text-sm text-slate-500">{t("didntReceiveOtp")}</p>

              {resendIn > 0 ? (
                <p className="mt-1 text-sm font-extrabold text-slate-400">
                  {t("resendOtpIn", {
                    seconds: resendIn,
                  })}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  className="mt-1 text-sm font-extrabold text-emerald-700 hover:underline disabled:text-slate-400"
                >
                  {resending ? t("sendingOtp") : t("resendOtp")}
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleVerify}
              disabled={submitting || expired}
              className="mt-6 flex min-h-14 w-full items-center justify-center rounded-xl bg-[#15803d] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#166534] active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-emerald-300"
            >
              {submitting ? t("verifying") : `${t("verifyAndContinue")} →`}
            </button>

            <button
              type="button"
              onClick={() =>
                navigate(
                  isStaff
                    ? "/staff-login"
                    : initial?.purpose === "register"
                      ? "/"
                      : "/login",
                  { replace: true },
                )
              }
              className="mt-3 flex min-h-12 w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-bold text-slate-500 transition hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700"
            >
              ← {t("changeMobileNumber")}
            </button>

            <div className="mt-6 flex items-center justify-center gap-2 border-t border-slate-100 pt-5 text-xs font-medium text-slate-400">
              <span>🔒</span>
              <span>{t("secureVerification")}</span>
            </div>
          </div>

          <p className="mt-5 text-center text-xs font-medium text-slate-400">
            {t("farmerProcurementPortal")}
          </p>
        </section>
      </main>
    </div>
  );
}

export default OTPVerification;

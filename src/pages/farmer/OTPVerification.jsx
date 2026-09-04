import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { DEMO_OTP_ENABLED } from "../../lib/api";
import { useAuth } from "../../auth/context";
import { translateError } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import { homePathFor } from "../../auth/roles";
import LanguageToggle from "../../components/LanguageToggle";

const OTP_LENGTH = 6;

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
  const [digits, setDigits] = useState(Array(OTP_LENGTH).fill(""));
  const [error, setError] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const inputRefs = useRef([]);

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

  const demoOtp = useApiResource(
    (signal) => api.devLastOtp(phone, signal),
    [phone, challenge?.challengeId],
    {
      enabled: DEMO_OTP_ENABLED && Boolean(phone),
    },
  );

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

    const pasted = event.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, OTP_LENGTH);

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

      const profile = await onSignedIn();

      navigate(homePathFor(profile), {
        replace: true,
      });
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
                {t("otpSentTo")}
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
                    setDigits(
                      demoOtp.data
                        .padEnd(OTP_LENGTH, "")
                        .slice(0, OTP_LENGTH)
                        .split(""),
                    );
                    setError(null);
                    setLocalError(null);
                  }}
                  className="mt-2 text-xs font-semibold text-amber-800 underline"
                >
                  {t("demoOtpFill")}
                </button>

                <p className="mt-2 text-[11px] leading-4 text-amber-700">
                  {t("demoOtpNote")}
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

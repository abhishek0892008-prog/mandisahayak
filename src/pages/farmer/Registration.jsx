import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import api from "../../lib/api";
import { translateError, translateFieldErrors, translateReason } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

const CONSENT_POLICY_VERSION = "v1";

function Registration() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [villageId, setVillageId] = useState("");
  const [consent, setConsent] = useState(false);

  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const districts = useApiResource((signal) => api.districts(signal), []);

  const villages = useApiResource(
    (signal) => api.villages(districtId, signal),
    [districtId],
    { enabled: Boolean(districtId) }
  );

  const villageOptions = villages.data?.available
    ? villages.data.villages ?? []
    : [];

  function clearFieldError(field) {
    setFieldErrors((previous) => {
      if (!previous[field]) return previous;

      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  function validate() {
    const errors = {};

    if (fullName.trim().length < 2) {
      errors.fullName = t("codes.fieldErrors.NAME_TOO_SHORT");
    }

    if (!/^[6-9]\d{9}$/.test(phone)) {
      errors.phone = t("codes.fieldErrors.PHONE_INVALID_INDIAN_MOBILE");
    }

    if (!districtId) {
      errors.districtId = t("codes.fieldErrors.DISTRICT_ID_INVALID");
    }

    if (!consent) {
      errors.consent = t("codes.fieldErrors.CONSENT_REQUIRED");
    }

    return errors;
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const errors = validate();

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    try {
      const challenge = await api.registerStartOtp({
        fullName: fullName.trim(),
        phone,
        districtId,
        villageId: villageId || undefined,
        locale: i18n.language === "hi" ? "hi" : "en",
        consent: {
          policyVersion: CONSENT_POLICY_VERSION,
          accepted: true,
        },
      });

      navigate("/verify-otp", {
        replace: true,
        state: {
          challenge,
          phone,
          purpose: "register",
        },
      });
    } catch (error) {
      const fields = translateFieldErrors(t, error);

      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setSubmitError(error);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const inputClasses = (hasError) =>
    `min-h-13 w-full rounded-xl border bg-white px-4 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-50 ${
      hasError ? "border-red-400" : "border-slate-200"
    }`;

  return (
    <div className="min-h-screen bg-[#f3f5f3] text-slate-900">
      <header className="bg-[#11a255] text-white">
        <div className="mx-auto flex min-h-[72px] w-full max-w-[1280px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex items-center gap-3 text-left"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-xl">
              🌾
            </span>

            <span>
              <span className="block text-lg font-extrabold tracking-tight">
                FarmQueue
              </span>

              <span className="hidden text-xs font-medium text-white/80 sm:block">
                Farmer Procurement Portal
              </span>
            </span>
          </button>

          <div className="flex items-center gap-2 sm:gap-3">
            <LanguageToggle variant="onGreen" />

            <button
              type="button"
              onClick={() => navigate("/login")}
              className="rounded-full border border-white/30 bg-white px-4 py-2 text-sm font-bold text-[#0b7f43] transition hover:bg-white/90"
            >
              {t("login")}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1000px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-12">
        <section className="mx-auto w-full max-w-[720px]">
          <div className="mb-7 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-2xl">
              🌾
            </div>

            <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
              {t("stepOf", { current: 1, total: 2 })}
            </p>

            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
              {t("createAccount")}
            </h1>

            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-500">
              {t("createAccountDescription")}
            </p>
          </div>

          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_4px_18px_rgba(16,64,42,0.04)] sm:p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-emerald-700">
                  {t("registrationStepLabel")}
                </p>

                <p className="mt-1 text-sm font-semibold text-slate-700">
                  {t("farmer")}
                </p>
              </div>

              <span className="text-xs font-semibold text-slate-400">
                50%
              </span>
            </div>

            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full w-1/2 rounded-full bg-[#11a255]" />
            </div>
          </div>

          {submitError && (
            <ErrorState
              error={submitError}
              className="mb-5"
              onRetry={() => setSubmitError(null)}
            />
          )}

          <div className="rounded-[24px] border border-slate-200 bg-white shadow-[0_8px_30px_rgba(16,64,42,0.06)]">
            <form
              onSubmit={handleSubmit}
              className="p-5 sm:p-7 lg:p-8"
              noValidate
            >
              <div className="border-b border-slate-100 pb-6">
                <h2 className="text-base font-extrabold text-slate-900">
                  {t("personalDetails")}
                </h2>

                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {t("personalDetailsDescription")}
                </p>

                <div className="mt-5 space-y-5">
                  <div>
                    <label
                      htmlFor="fullName"
                      className="mb-2 block text-sm font-bold text-slate-700"
                    >
                      {t("fullName")}
                    </label>

                    <input
                      id="fullName"
                      type="text"
                      value={fullName}
                      onChange={(event) => {
                        setFullName(event.target.value);
                        clearFieldError("fullName");
                      }}
                      placeholder={t("fullNamePlaceholder")}
                      autoComplete="name"
                      className={inputClasses(fieldErrors.fullName)}
                    />

                    {fieldErrors.fullName && (
                      <p className="mt-1.5 text-xs font-medium text-red-500">
                        {fieldErrors.fullName}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="phone"
                      className="mb-2 block text-sm font-bold text-slate-700"
                    >
                      {t("mobileNumber")}
                    </label>

                    <div
                      className={`flex overflow-hidden rounded-xl border bg-white transition focus-within:border-emerald-500 focus-within:ring-4 focus-within:ring-emerald-50 ${
                        fieldErrors.phone
                          ? "border-red-400"
                          : "border-slate-200"
                      }`}
                    >
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
                            event.target.value
                              .replace(/\D/g, "")
                              .slice(0, 10)
                          );
                          clearFieldError("phone");
                        }}
                        className="min-h-13 min-w-0 flex-1 bg-white px-4 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                      />
                    </div>

                    {fieldErrors.phone ? (
                      <p className="mt-1.5 text-xs font-medium text-red-500">
                        {fieldErrors.phone}
                      </p>
                    ) : (
                      <p className="mt-1.5 text-xs text-slate-400">
                        {t("otpWillBeSent")}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="border-b border-slate-100 py-6">
                <h2 className="text-base font-extrabold text-slate-900">
                  {t("locationDetails")}
                </h2>

                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {t("locationDetailsDescription")}
                </p>

                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="districtId"
                      className="mb-2 block text-sm font-bold text-slate-700"
                    >
                      {t("district")}
                    </label>

                    <select
                      id="districtId"
                      value={districtId}
                      disabled={districts.loading || Boolean(districts.error)}
                      onChange={(event) => {
                        setDistrictId(event.target.value);
                        setVillageId("");
                        clearFieldError("districtId");
                        clearFieldError("villageId");
                      }}
                      className={inputClasses(fieldErrors.districtId)}
                    >
                      <option value="">
                        {districts.loading
                          ? t("loading")
                          : t("selectDistrict")}
                      </option>

                      {(districts.data ?? []).map((district) => (
                        <option key={district.id} value={district.id}>
                          {district.name}
                        </option>
                      ))}
                    </select>

                    {districts.error && (
                      <p className="mt-1.5 text-xs font-medium text-red-500">
                        {translateError(t, districts.error)}
                      </p>
                    )}

                    {fieldErrors.districtId && (
                      <p className="mt-1.5 text-xs font-medium text-red-500">
                        {fieldErrors.districtId}
                      </p>
                    )}
                  </div>

                  {districtId && villageOptions.length > 0 && (
                    <div>
                      <label
                        htmlFor="villageId"
                        className="mb-2 block text-sm font-bold text-slate-700"
                      >
                        {t("village")}
                      </label>

                      <select
                        id="villageId"
                        value={villageId}
                        onChange={(event) => {
                          setVillageId(event.target.value);
                          clearFieldError("villageId");
                        }}
                        className={inputClasses(fieldErrors.villageId)}
                      >
                        <option value="">{t("optional")}</option>

                        {villageOptions.map((village) => (
                          <option key={village.id} value={village.id}>
                            {village.name}
                          </option>
                        ))}
                      </select>

                      {fieldErrors.villageId && (
                        <p className="mt-1.5 text-xs font-medium text-red-500">
                          {fieldErrors.villageId}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {districtId &&
                  !villages.loading &&
                  villages.data &&
                  !villages.data.available && (
                    <p className="mt-3 text-xs text-slate-400">
                      {translateReason(t, villages.data.reasonCode)}
                    </p>
                  )}
              </div>

              <div className="py-6">
                <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-4">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      id="consent"
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => {
                        setConsent(event.target.checked);
                        clearFieldError("consent");
                      }}
                      className="mt-1 h-4 w-4 accent-[#0b7f43]"
                    />

                    <span className="text-xs leading-5 text-slate-600">
                      {t("consentText")}
                    </span>
                  </label>

                  {fieldErrors.consent && (
                    <p className="mt-2 text-xs font-medium text-red-500">
                      {fieldErrors.consent}
                    </p>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex min-h-14 w-full items-center justify-center rounded-xl bg-[#0b7f43] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-[#096b39] disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
              >
                {submitting ? t("sendingOtp") : t("continueToOtp")}
                <span className="ml-2 text-lg">→</span>
              </button>

              <div className="mt-6 text-center">
                <span className="text-xs text-slate-400">
                  {t("alreadyRegistered")}
                </span>

                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="ml-1 text-xs font-bold text-emerald-700 hover:underline"
                >
                  {t("loginLink")}
                </button>
              </div>
            </form>
          </div>

          <p className="mt-5 text-center text-xs font-medium text-slate-400">
            {t("secureProcurement")}
          </p>
        </section>
      </main>
    </div>
  );
}

export default Registration;
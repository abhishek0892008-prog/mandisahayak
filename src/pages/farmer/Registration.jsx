import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateError, translateFieldErrors, translateReason } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

/**
 * The policy version recorded with the consent. It is sent as a value rather
 * than assumed server-side so the exact text a farmer agreed to is auditable.
 */
const CONSENT_POLICY_VERSION = "v1";

/**
 * Farmer registration.
 *
 * Two things changed from the prototype and both were required, not optional:
 *
 *  - **The bank account and IFSC fields are gone.** No column exists for them
 *    (decisions D-6/D-7), the endpoint ignores them, and the project's public
 *    claim is that no bank details are collected anywhere. A form that asked
 *    for them made that claim false.
 *  - **Districts come from the API and are sent as ids.** The hardcoded name
 *    list could not have satisfied an endpoint that requires a UUID.
 */
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

  // Villages are fetched only once a district is chosen, and the response says
  // whether any exist. An empty list is the correct answer today, not a bug
  // (farmer.md §6) — so the field is hidden rather than shown empty.
  const villages = useApiResource(
    (signal) => api.villages(districtId, signal),
    [districtId],
    { enabled: Boolean(districtId) },
  );

  const villageOptions = villages.data?.available ? (villages.data.villages ?? []) : [];

  function clearFieldError(field) {
    setFieldErrors((previous) => {
      if (!previous[field]) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  /**
   * Client-side checks exist to save a round trip, never to decide anything.
   * The server re-applies every rule and its answer is the one that counts.
   */
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
        consent: { policyVersion: CONSENT_POLICY_VERSION, accepted: true },
      });

      // The challenge travels in router state, never in storage: it is
      // short-lived, and the OTP screen is the only consumer.
      navigate("/verify-otp", {
        replace: true,
        state: { challenge, phone, purpose: "register" },
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
    `w-full border rounded-lg p-3 bg-gray-50 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100 ${
      hasError ? "border-red-400" : "border-gray-200"
    }`;

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
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">
              {t("stepOf", { current: 1, total: 2 })}
            </span>

            <span className="text-xs text-gray-400">{t("registrationStepLabel")}</span>
          </div>

          <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="w-1/2 h-full bg-green-700 rounded-full" />
          </div>

          <h2 className="text-xl font-semibold mt-6 text-gray-900">{t("createAccount")}</h2>

          <p className="text-gray-500 text-sm mt-1 mb-6">{t("createAccountDescription")}</p>
        </div>

        {submitError && (
          <ErrorState error={submitError} className="mb-4" onRetry={() => setSubmitError(null)} />
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="fullName" className="block text-sm font-medium text-gray-700 mb-1">
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
              <p className="text-xs text-red-500 mt-1">{fieldErrors.fullName}</p>
            )}
          </div>

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
                  clearFieldError("phone");
                }}
                className={`flex-1 border rounded-r-lg p-3 bg-gray-50 outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100 ${
                  fieldErrors.phone ? "border-red-400" : "border-gray-200"
                }`}
              />
            </div>

            {fieldErrors.phone ? (
              <p className="text-xs text-red-500 mt-1.5">{fieldErrors.phone}</p>
            ) : (
              <p className="text-xs text-gray-400 mt-1.5">{t("otpWillBeSent")}</p>
            )}
          </div>

          <div>
            <label htmlFor="districtId" className="block text-sm font-medium text-gray-700 mb-1">
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
              }}
              className={inputClasses(fieldErrors.districtId)}
            >
              <option value="">
                {districts.loading ? t("loading") : t("selectDistrict")}
              </option>

              {(districts.data ?? []).map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>

            {districts.error && (
              <p className="text-xs text-red-500 mt-1">{translateError(t, districts.error)}</p>
            )}

            {fieldErrors.districtId && (
              <p className="text-xs text-red-500 mt-1">{fieldErrors.districtId}</p>
            )}
          </div>

          {/*
            The village field appears only when the server actually has village
            data. Rendering an empty dropdown, or falling back to the
            prototype's unverified list, would both be wrong (farmer.md §6).
          */}
          {districtId && villageOptions.length > 0 && (
            <div>
              <label htmlFor="villageId" className="block text-sm font-medium text-gray-700 mb-1">
                {t("village")}
              </label>

              <select
                id="villageId"
                value={villageId}
                onChange={(event) => setVillageId(event.target.value)}
                className={inputClasses(fieldErrors.villageId)}
              >
                <option value="">{t("optional")}</option>

                {villageOptions.map((village) => (
                  <option key={village.id} value={village.id}>
                    {village.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {districtId && !villages.loading && villages.data && !villages.data.available && (
            <p className="text-xs text-gray-400">
              {translateReason(t, villages.data.reasonCode)}
            </p>
          )}

          <div className="flex items-start gap-2 pt-1">
            <input
              id="consent"
              type="checkbox"
              checked={consent}
              onChange={(event) => {
                setConsent(event.target.checked);
                clearFieldError("consent");
              }}
              className="mt-1 accent-green-700"
            />

            <label htmlFor="consent" className="text-xs leading-4 text-gray-500">
              {t("consentText")}
            </label>
          </div>

          {fieldErrors.consent && <p className="text-xs text-red-500">{fieldErrors.consent}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-green-700 hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-300 text-white font-semibold py-3 rounded-lg transition"
          >
            {submitting ? t("sendingOtp") : `${t("continueToOtp")} →`}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-5">
          {t("alreadyRegistered")}{" "}
          <button
            type="button"
            onClick={() => navigate("/login")}
            className="text-green-700 font-semibold hover:underline"
          >
            {t("loginLink")}
          </button>
        </p>

        <p className="text-center text-xs text-gray-400 mt-5">{t("secureProcurement")}</p>
      </div>
    </div>
  );
}

export default Registration;

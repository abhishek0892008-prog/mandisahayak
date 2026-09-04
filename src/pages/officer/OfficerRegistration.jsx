import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { translateError, translateFieldErrors } from "../../lib/codes";
import useApiResource from "../../hooks/useApiResource";
import LanguageToggle from "../../components/LanguageToggle";
import { ErrorState } from "../../components/StateViews";

const CONSENT_POLICY_VERSION = "v1";

/**
 * Officer account registration.
 *
 * Laid out like the farmer registration it sits beside, with the fields an
 * officer application needs: identity, district, procurement centre, and crop.
 *
 * Registration creates the officer account immediately and verifies the
 * submitted mobile number through the shared OTP screen.
 */
function OfficerRegistration() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [centreId, setCentreId] = useState("");
  const [cropId, setCropId] = useState("");
  const [consent, setConsent] = useState(false);

  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const districts = useApiResource((signal) => api.districts(signal), []);

  // Centres are fetched per district: the server rejects a centre that is not
  // in the district named, so offering the full list would only invite that
  // error.
  const centres = useApiResource(
    (signal) => api.registrationCentres(districtId, signal),
    [districtId],
    { enabled: Boolean(districtId) },
  );

  const centreOptions = centres.data ?? [];
  const selectedCentre = centreOptions.find((centre) => centre.id === centreId);
  const acceptedCrops = selectedCentre?.acceptedCrops ?? [];

  function clearFieldError(field) {
    setFieldErrors((previous) => {
      if (!previous[field]) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  /** Saves a round trip only. The server re-applies every one of these. */
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

    if (!centreId) {
      errors.centreId = t("codes.fieldErrors.CENTRE_ID_INVALID");
    }

    if (!cropId) {
      errors.cropId = t("codes.fieldErrors.CROP_ID_INVALID");
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
      const challenge = await api.staffRegister({
        fullName: fullName.trim(),
        phone: `+91${phone}`,
        districtId,
        centreId,
        cropId,
        consent: { policyVersion: CONSENT_POLICY_VERSION, accepted: true },
      });

      navigate("/verify-otp", {
        replace: true,
        state: { challenge, phone, purpose: "staff" },
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

  const header = (
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
              Mandi Sahayak
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
            onClick={() => navigate("/staff-login")}
            className="rounded-full border border-white/30 bg-white px-4 py-2 text-sm font-bold text-[#15803d] transition hover:bg-white/90"
          >
            {t("login")}
          </button>
        </div>
      </div>
    </header>
  );

  return (
    <div className="min-h-screen bg-[#f3f5f3] text-slate-900">
      {header}

      <main className="mx-auto w-full max-w-[1000px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8 lg:py-12">
        <section className="mx-auto w-full max-w-[720px]">
          <div className="mb-7 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 text-2xl">
              🏛️
            </div>

            <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-emerald-700">
              {t("officer")}
            </p>

            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
              {t("officerRegistration")}
            </h1>

            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-500">
              {t("officerRegistrationDescription")}
            </p>
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
              {/* ---- identity ---------------------------------------------- */}
              <div className="border-b border-slate-100 pb-6">
                <h2 className="text-base font-extrabold text-slate-900">
                  {t("personalDetails")}
                </h2>

                <p className="mt-1 text-xs leading-5 text-slate-400">
                  {t("officerPersonalDetailsDescription")}
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
                      autoComplete="name"
                      placeholder={t("fullNamePlaceholder")}
                      onChange={(event) => {
                        setFullName(event.target.value);
                        clearFieldError("fullName");
                      }}
                      className={inputClasses(fieldErrors.fullName)}
                    />

                    {fieldErrors.fullName && (
                      <p className="mt-2 text-xs font-medium text-red-500">
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
                      className={`flex overflow-hidden rounded-xl border bg-white transition focus-within:ring-4 focus-within:ring-emerald-50 ${
                        fieldErrors.phone
                          ? "border-red-400 focus-within:border-red-500"
                          : "border-slate-200 focus-within:border-emerald-500"
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
                            event.target.value.replace(/\D/g, "").slice(0, 10),
                          );
                          clearFieldError("phone");
                        }}
                        className="min-h-13 min-w-0 flex-1 bg-white px-4 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                      />
                    </div>

                    {fieldErrors.phone && (
                      <p className="mt-2 text-xs font-medium text-red-500">
                        {fieldErrors.phone}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* ---- assignment -------------------------------------------- */}
              <div className="border-b border-slate-100 py-6">
                <h2 className="text-base font-extrabold text-slate-900">
                  {t("postingDetails")}
                </h2>

                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Select your district, procurement centre, and an accepted
                  crop.
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
                      disabled={districts.loading}
                      onChange={(event) => {
                        setDistrictId(event.target.value);
                        setCentreId("");
                        clearFieldError("districtId");
                        clearFieldError("centreId");
                      }}
                      className={inputClasses(
                        fieldErrors.districtId || districts.error,
                      )}
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
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-xs font-medium text-red-500">
                          {t("districtsUnavailable")}{" "}
                          {translateError(t, districts.error)}
                        </p>

                        <button
                          type="button"
                          onClick={districts.reload}
                          className="text-xs font-bold text-green-700 hover:underline"
                        >
                          {t("tryAgain")}
                        </button>
                      </div>
                    )}

                    {fieldErrors.districtId && (
                      <p className="mt-2 text-xs font-medium text-red-500">
                        {fieldErrors.districtId}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="centreId"
                      className="mb-2 block text-sm font-bold text-slate-700"
                    >
                      {t("procurementCentre")}
                    </label>

                    <select
                      id="centreId"
                      value={centreId}
                      disabled={!districtId || centres.loading}
                      onChange={(event) => {
                        setCentreId(event.target.value);
                        clearFieldError("centreId");
                      }}
                      className={inputClasses(
                        fieldErrors.centreId || centres.error,
                      )}
                    >
                      <option value="">
                        {!districtId
                          ? t("selectDistrictFirst")
                          : centres.loading
                            ? t("loading")
                            : t("selectProcurementCentre")}
                      </option>

                      {centreOptions.map((centre) => (
                        <option key={centre.id} value={centre.id}>
                          {centre.name}
                        </option>
                      ))}
                    </select>

                    {districtId &&
                      !centres.loading &&
                      !centres.error &&
                      centreOptions.length === 0 && (
                        <p className="mt-2 text-xs text-slate-400">
                          {t("noCentresInDistrict")}
                        </p>
                      )}

                    {centres.error && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-xs font-medium text-red-500">
                          {translateError(t, centres.error)}
                        </p>

                        <button
                          type="button"
                          onClick={centres.reload}
                          className="text-xs font-bold text-green-700 hover:underline"
                        >
                          {t("tryAgain")}
                        </button>
                      </div>
                    )}

                    {fieldErrors.centreId && (
                      <p className="mt-2 text-xs font-medium text-red-500">
                        {fieldErrors.centreId}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="cropId"
                      className="mb-2 block text-sm font-bold text-slate-700"
                    >
                      {t("crop")}
                    </label>

                    <select
                      id="cropId"
                      value={cropId}
                      disabled={!centreId || centres.loading}
                      onChange={(event) => {
                        setCropId(event.target.value);
                        clearFieldError("cropId");
                      }}
                      className={inputClasses(fieldErrors.cropId)}
                    >
                      <option value="">
                        {!centreId ? t("selectCentreFirst") : t("selectCrop")}
                      </option>
                      {acceptedCrops.map((crop) => (
                        <option key={crop.id} value={crop.id}>
                          {crop.name}
                        </option>
                      ))}
                    </select>

                    {fieldErrors.cropId && (
                      <p className="mt-2 text-xs font-medium text-red-500">
                        {fieldErrors.cropId}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2.5 pt-6">
                <input
                  id="consent"
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => {
                    setConsent(event.target.checked);
                    clearFieldError("consent");
                  }}
                  className="mt-0.5 h-4 w-4 accent-[#11a255]"
                />

                <label
                  htmlFor="consent"
                  className="text-xs leading-5 text-slate-500"
                >
                  {t("officerConsentText")}
                </label>
              </div>

              {fieldErrors.consent && (
                <p className="mt-2 text-xs font-medium text-red-500">
                  {fieldErrors.consent}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-6 min-h-13 w-full rounded-xl bg-[#11a255] text-sm font-bold text-white transition hover:bg-[#0e8b49] disabled:cursor-not-allowed disabled:bg-emerald-300"
              >
                {submitting ? t("submitting") : `${t("submitApplication")} →`}
              </button>
            </form>
          </div>

          <p className="mt-5 text-center text-sm text-slate-500">
            {t("alreadyHaveOfficerAccount")}{" "}
            <button
              type="button"
              onClick={() => navigate("/staff-login")}
              className="font-bold text-emerald-700 hover:underline"
            >
              {t("staffLogin")}
            </button>
          </p>
        </section>
      </main>
    </div>
  );
}

export default OfficerRegistration;

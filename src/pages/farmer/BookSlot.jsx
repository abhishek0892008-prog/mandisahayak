import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { newIdempotencyKey } from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import { filterCrops } from "../../data/crops";
import { translateError, translateReason } from "../../lib/codes";
import {
  formatDate,
  formatMinutes,
  formatTimeRange,
  quintalToKg,
  todayInZone,
} from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import { DataTypeNote, ErrorState, Loading, MandiNote } from "../../components/StateViews";

function BookSlot() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [cropId, setCropId] = useState("");
  const [cropQuery, setCropQuery] = useState("");
  const [cropListOpen, setCropListOpen] = useState(false);
  const [centreId, setCentreId] = useState("");
  const [quantityQuintal, setQuantityQuintal] = useState("");
  const [preferredDate, setPreferredDate] = useState("");

  const [offer, setOffer] = useState(null);
  const [searching, setSearching] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState(null);
  const [fieldError, setFieldError] = useState(null);

  const cropBoxRef = useRef(null);
  const idempotencyKey = useRef(newIdempotencyKey());

  const crops = useApiResource((signal) => api.crops(signal), []);
  const constraints = useApiResource((signal) => api.bookingConstraints(signal), []);
  const centres = useApiResource(
    (signal) => api.centres({ cropId }, signal),
    [cropId],
    { enabled: Boolean(cropId) },
  );

  const quantity = constraints.data?.quantity ?? null;
  const locale = i18n.language;

  const selectedCrop = (crops.data ?? []).find((crop) => crop.id === cropId) ?? null;
  const selectedCentre = (centres.data ?? []).find((centre) => centre.id === centreId) ?? null;

  const visibleCrops = useMemo(
    () => filterCrops(crops.data ?? [], cropQuery),
    [crops.data, cropQuery],
  );

  const centreZone = selectedCentre?.timezone ?? "Asia/Kolkata";
  const minDate = todayInZone(centreZone);
  useEffect(() => {
    if (!cropListOpen) return undefined;

    function onPointerDown(event) {
      if (cropBoxRef.current && !cropBoxRef.current.contains(event.target)) {
        setCropListOpen(false);
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [cropListOpen]);

  function invalidateOffer() {
    setOffer(null);
    setError(null);
    idempotencyKey.current = newIdempotencyKey();
  }

  function validate() {
    if (!cropId) return t("codes.fieldErrors.CROP_ID_INVALID");
    if (!centreId) return t("codes.fieldErrors.CENTRE_ID_INVALID");

    const value = Number(quantityQuintal);

    if (!quantityQuintal || !Number.isFinite(value)) {
      return t("codes.fieldErrors.QUANTITY_NOT_INTEGER");
    }

    if (quantity) {
      if (quantity.integerOnly && !Number.isInteger(value)) {
        return t("codes.fieldErrors.QUANTITY_NOT_INTEGER");
      }

      if (value < quantity.minQuintal) return t("codes.fieldErrors.QUANTITY_BELOW_MINIMUM");
      if (value > quantity.maxQuintal) return t("codes.fieldErrors.QUANTITY_ABOVE_MAXIMUM");
    }

    return null;
  }

  async function handleCheckAvailability(event) {
    event.preventDefault();

    const invalid = validate();

    if (invalid) {
      setFieldError(invalid);
      return;
    }

    setFieldError(null);
    setError(null);
    setSearching(true);
    setOffer(null);

    try {
      const result = await api.availability({
        centreId,
        cropId,
        quantityKg: quintalToKg(quantityQuintal, quantity?.kgPerQuintal ?? 100),
        fromDate: preferredDate || undefined,
      });

      setOffer(result);
    } catch (searchError) {
      setError(searchError);
    } finally {
      setSearching(false);
    }
  }

  async function handleConfirm() {
    setBooking(true);
    setError(null);

    try {
      const created = await api.createBooking(
        {
          centreId,
          cropId,
          quantityKg: quintalToKg(quantityQuintal, quantity?.kgPerQuintal ?? 100),
          preferredDate: preferredDate || undefined,
        },
        idempotencyKey.current,
      );
      navigate("/booking-confirmation", { replace: true, state: { booking: created } });
    } catch (bookError) {
      setError(bookError);
      if (bookError?.code === "SLOT_NO_LONGER_AVAILABLE") {
        setOffer(null);
        idempotencyKey.current = newIdempotencyKey();
      }
    } finally {
      setBooking(false);
    }
  }

  const card = "rounded-2xl bg-white p-4 shadow-sm";
  const control =
    "min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100";

  return (
    <FarmerLayout
      title={t("bookSlot")}
      subtitle={t("chooseCentreCropTime")}
      onBack={() => navigate("/dashboard")}
    >
      {(crops.error || constraints.error) && (
        <ErrorState
          error={crops.error ?? constraints.error}
          className="mb-4"
          onRetry={() => {
            crops.reload();
            constraints.reload();
          }}
        />
      )}

      {crops.initialLoading && <Loading />}

      {!crops.initialLoading && (
        <form onSubmit={handleCheckAvailability} className="space-y-4">
          {}
          <section className={card}>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-lg">
                🌾
              </div>

              <div>
                <h2 className="font-semibold text-slate-900">{t("crop")}</h2>
                <p className="text-xs text-slate-500">{t("selectCropDescription")}</p>
              </div>
            </div>

            <div className="relative" ref={cropBoxRef}>
              <button
                type="button"
                onClick={() => setCropListOpen((open) => !open)}
                className={`flex items-center justify-between text-left ${control}`}
              >
                <span className={selectedCrop ? "text-slate-900" : "text-slate-400"}>
                  {selectedCrop ? selectedCrop.canonicalName : t("selectCrop")}
                </span>
                <span className="text-slate-400">▾</span>
              </button>

              {cropListOpen && (
                <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                  <div className="sticky top-0 border-b border-slate-100 bg-white p-2">
                    <input
                      type="text"
                      value={cropQuery}
                      autoFocus
                      onChange={(event) => setCropQuery(event.target.value)}
                      placeholder={t("searchCrop")}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-green-600"
                    />
                  </div>

                  {visibleCrops.length === 0 && (
                    <p className="px-3 py-4 text-center text-sm text-slate-400">
                      {t("noCropsMatch")}
                    </p>
                  )}

                  {visibleCrops.map((crop) => (
                    <button
                      key={crop.id}
                      type="button"
                      onClick={() => {
                        setCropId(crop.id);
                        setCentreId("");
                        setCropListOpen(false);
                        setCropQuery("");
                        invalidateOffer();
                      }}
                      className={`flex w-full items-center justify-between px-3 py-3 text-left text-sm hover:bg-green-50 ${
                        crop.id === cropId ? "bg-green-50 font-semibold" : ""
                      }`}
                    >
                      {}
                      <span className="text-slate-800">{crop.canonicalName}</span>

                      <span className="ml-2 shrink-0 text-xs text-slate-400">
                        {crop.season?.code} {crop.marketingYear}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {}
          <section className={card}>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-lg">
                📍
              </div>

              <div>
                <h2 className="font-semibold text-slate-900">{t("procurementCentre")}</h2>
                <p className="text-xs text-slate-500">{t("selectCentreDescription")}</p>
              </div>
            </div>

            <select
              value={centreId}
              disabled={!cropId || centres.loading}
              onChange={(event) => {
                setCentreId(event.target.value);
                invalidateOffer();
              }}
              className={`${control} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
            >
              <option value="">
                {!cropId
                  ? t("selectCropFirst")
                  : centres.loading
                    ? t("loading")
                    : t("selectProcurementCentre")}
              </option>

              {(centres.data ?? []).map((centre) => (
                <option key={centre.id} value={centre.id}>
                  {centre.mandi ? `${centre.mandi.name} Mandi` : centre.name} —{" "}
                  {centre.district?.name}
                </option>
              ))}
            </select>

            {cropId && !centres.loading && (centres.data ?? []).length === 0 && (
              <p className="mt-2 text-xs text-amber-700">{t("noCentresForCrop")}</p>
            )}

            {centres.error && (
              <p className="mt-2 text-xs text-red-500">{translateError(t, centres.error)}</p>
            )}

            {selectedCentre?.mandi && <MandiNote mandi={selectedCentre.mandi} />}

            {selectedCentre && <DataTypeNote dataType={selectedCentre.dataType} />}
          </section>

          {}
          <section className={card}>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-lg">
                ⚖️
              </div>

              <div>
                <h2 className="font-semibold text-slate-900">{t("quantity")}</h2>
                <p className="text-xs text-slate-500">{t("quantityDescription")}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="number"
                value={quantityQuintal}
                min={quantity?.minQuintal}
                max={quantity?.maxQuintal}
                step={quantity?.integerOnly ? 1 : "any"}
                inputMode="numeric"
                placeholder={t("enterQuantity")}
                onChange={(event) => {
                  setQuantityQuintal(event.target.value);
                  setFieldError(null);
                  invalidateOffer();
                }}
                className={control}
              />

              <span className="shrink-0 text-sm font-medium text-slate-500">{t("quintal")}</span>
            </div>

            {}
            <p className="mt-2 text-xs text-slate-400">
              {quantity
                ? t("quantityRange", { min: quantity.minQuintal, max: quantity.maxQuintal })
                : t("loading")}
            </p>
          </section>

          {}
          <section className={card}>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-lg">
                📅
              </div>

              <div>
                <h2 className="font-semibold text-slate-900">{t("preferredDate")}</h2>
                <p className="text-xs text-slate-500">{t("preferredDateHelp")}</p>
              </div>
            </div>

            <input
              type="date"
              value={preferredDate}
              min={minDate}
              onChange={(event) => {
                setPreferredDate(event.target.value);
                invalidateOffer();
              }}
              className={control}
            />
          </section>

          {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}

          {error && <ErrorState error={error} />}

          <button
            type="submit"
            disabled={searching}
            className="min-h-12 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-300"
          >
            {searching ? t("checkingAvailability") : t("searchAvailability")}
          </button>
        </form>
      )}

      {}
      {offer && !offer.available && (
        <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <h3 className="font-semibold text-amber-900">{t("noAvailabilityTitle")}</h3>

          <p className="mt-1 text-sm leading-5 text-amber-800">
            {translateReason(t, offer.reasonCode)}
          </p>
        </section>
      )}

      {offer?.available && offer.window && (
        <section className="mt-4 overflow-hidden rounded-2xl border border-green-200 bg-white shadow-sm">
          <div className="bg-green-50 px-4 py-3">
            <h3 className="font-semibold text-green-900">{t("earliestAvailableWindow")}</h3>
          </div>

          <div className="divide-y divide-slate-100 px-4">
            <div className="flex items-center justify-between py-3">
              <span className="text-sm text-slate-500">{t("date")}</span>
              <span className="text-sm font-semibold text-slate-900">
                {formatDate(offer.window.serviceDate, offer.window.centreTimezone, locale)}
              </span>
            </div>

            <div className="flex items-center justify-between py-3">
              <span className="text-sm text-slate-500">{t("arriveBy")}</span>
              <span className="text-sm font-semibold text-slate-900">
                {formatTimeRange(
                  offer.window.scheduledStartAt,
                  offer.window.processingEndAt,
                  offer.window.centreTimezone,
                  locale,
                )}
              </span>
            </div>

            <div className="flex items-center justify-between py-3">
              <span className="text-sm text-slate-500">{t("processingTime")}</span>
              <span className="text-sm font-semibold text-slate-900">
                {formatMinutes(offer.window.processingMinutes, locale, {
                  hour: t("hoursShort"),
                  minute: t("minutesShort"),
                })}
              </span>
            </div>

            <div className="flex items-center justify-between py-3">
              <span className="text-sm text-slate-500">{t("lane")}</span>
              <span className="text-sm font-semibold text-slate-900">{offer.window.laneNo}</span>
            </div>
          </div>

          {}
          {offer.storageCheck?.status === "NOT_AVAILABLE" && (
            <p className="px-4 pb-2 text-xs text-slate-400">
              {translateReason(t, offer.storageCheck.reasonCode)}
            </p>
          )}

          <div className="p-4 pt-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={booking}
              className="min-h-12 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-green-300"
            >
              {booking ? t("confirmingBooking") : t("bookThisWindow")}
            </button>

            <p className="mt-2 text-center text-xs text-slate-400">{t("windowNotHeldNote")}</p>
          </div>
        </section>
      )}
    </FarmerLayout>
  );
}

export default BookSlot;

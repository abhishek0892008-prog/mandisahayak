import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import useOfficerCentre from "../../hooks/useOfficerCentre";
import { translateDisplayStatus } from "../../lib/codes";
import { formatQuantity, formatTime, kgToQuintal, todayInZone } from "../../lib/format";
import OfficerLayout from "../../components/OfficerLayout";
import CentrePicker from "../../components/CentrePicker";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/** A booking is "cleared" once it is off the floor — procured and closed out. */
const CLEARED_STATUSES = ["COMPLETED", "CANCELLED", "NO_SHOW"];

/** The queue's pill buttons — status tabs and crop filters share one look. */
function FilterPill({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full border px-3 py-1.5 text-sm font-semibold transition",
        active
          ? "border-green-700 bg-green-700 text-white"
          : "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/**
 * One booking as a queue card.
 *
 * The prototype's card is read-only here: slot time, quantity and lane are
 * assigned by the server, so this screen shows them and hands the officer off
 * to gate entry rather than letting them be edited in place.
 */
function QueueCard({ row, isHighlighted, timezone, locale, t, onOpen }) {
  return (
    <div
      className={[
        "mb-3 min-w-0 rounded-2xl border p-3 shadow-sm transition sm:p-4",
        isHighlighted
          ? "border-emerald-400 bg-emerald-50 shadow-emerald-200/60"
          : "border-emerald-200 bg-white",
      ].join(" ")}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-lg font-black text-slate-900">
            {t("tokenNumberLabel")} {row.tokenNumber}
          </p>

          <p className="font-mono text-sm text-slate-600">{row.bookingCode}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
            {row.crop?.name}
          </span>

          <StatusBadge
            status={row.status}
            label={translateDisplayStatus(t, row.displayStatus)}
          />
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          {t("arriveBy")}
          <div className="mt-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium normal-case tracking-normal text-slate-900">
            {formatTime(row.scheduledStartAt, timezone, locale) || t("notAvailableShort")}
          </div>
        </div>

        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          {t("quantity")}
          <div className="mt-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium normal-case tracking-normal text-slate-900">
            {formatQuantity(kgToQuintal(row.quantityKg), locale)} {t("quintal")}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          {t("lane")}
          <div className="mt-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium normal-case tracking-normal text-slate-900">
            {row.laneNo ?? t("notAvailableShort")}
          </div>
        </div>

        <div className="flex items-end justify-center">
          <button
            type="button"
            onClick={onOpen}
            className="w-full rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-green-800"
          >
            {t("open")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Today at this centre.
 *
 * Replaces the prototype's "morning setup" dashboard, which mixed two
 * different jobs: looking at today's work (an officer's) and configuring the
 * centre — operating hours, slot capacity, accepted crops, MSP rates (an
 * admin's, and served by `/admin/centres/*`). Configuration lives in the admin
 * portal now; this screen shows the day.
 *
 * The layout follows the Faramqueue prototype's queue screen: an overview
 * band, status and crop filter pills, then the day as a list of cards.
 *
 * The date defaults to today IN THE CENTRE'S TIMEZONE, which is what the
 * endpoint does when no date is supplied.
 */
function OfficerToday() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const centre = useOfficerCentre();
  const [date, setDate] = useState(null);
  const [selectedCrop, setSelectedCrop] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("Active");

  const effectiveDate = date ?? todayInZone(centre.timezone);

  const bookings = useApiResource(
    (signal) => api.centreBookings(centre.centreId, { date: effectiveDate }, signal),
    [centre.centreId, effectiveDate],
    { enabled: Boolean(centre.centreId) },
  );

  // listDay returns { centreId, serviceDate, count, bookings }, not a bare
  // array — reading it as one made every officer screen throw on render.
  const rows = useMemo(() => bookings.data?.bookings ?? [], [bookings.data]);
  const locale = i18n.language;

  const countOf = (...statuses) =>
    rows.filter((row) => statuses.includes(row.status)).length;

  const stats = [
    { label: t("expected"), value: rows.length },
    { label: t("arrived"), value: countOf("ARRIVED", "WEIGHING", "QUALITY_CHECK") },
    { label: t("completedToday"), value: countOf("COMPLETED", "PAYMENT_PENDING") },
    { label: t("notAttended"), value: countOf("NO_SHOW") },
  ];

  const visibleRows = useMemo(
    () =>
      rows.filter((row) =>
        selectedStatus === "Active"
          ? !CLEARED_STATUSES.includes(row.status)
          : CLEARED_STATUSES.includes(row.status),
      ),
    [rows, selectedStatus],
  );

  const cropFilters = [
    "All",
    ...new Set(visibleRows.map((row) => row.crop?.name).filter(Boolean)),
  ];

  const filteredRows = useMemo(() => {
    if (selectedCrop === "All") return visibleRows;
    return visibleRows.filter((row) => row.crop?.name === selectedCrop);
  }, [selectedCrop, visibleRows]);

  const headerTitle = selectedStatus === "Active" ? t("queueList") : t("clearedToday");

  return (
    <OfficerLayout
      title={t("todaysProcurement")}
      subtitle={t("liveQueue")}
      stats={stats}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <CentrePicker centre={centre} />

          <label className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-slate-900">
            <span className="text-xs uppercase tracking-[0.14em] text-emerald-700">
              {t("dateLabel")}
            </span>

            <input
              type="date"
              value={effectiveDate}
              onChange={(event) => setDate(event.target.value)}
              className="bg-transparent text-sm font-semibold text-slate-900 outline-none"
            />
          </label>
        </div>
      }
    >
      {centre.error && <ErrorState error={centre.error} onRetry={centre.reload} />}

      {centre.loading && <Loading />}

      {!centre.loading && !centre.centreId && !centre.error && (
        <EmptyState icon="🏛️" title={t("noCentreAssigned")} description={t("noCentreAssignedNote")} />
      )}

      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {centre.centreId && bookings.initialLoading && <Loading />}

      {centre.centreId && !bookings.initialLoading && rows.length === 0 && !bookings.error && (
        <EmptyState icon="📋" title={t("noBookingsToday")} description={t("noBookingsTodayNote")} />
      )}

      {rows.length > 0 && (
        <div className="space-y-5">
          <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-bold text-slate-900">{t("queueOverview")}</h3>

              <span className="rounded-full bg-green-700 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white">
                {t("totalSlotsToday", { count: rows.length })}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { label: t("activeLabel"), value: "Active" },
              { label: t("clearedToday"), value: "Cleared" },
            ].map((tab) => (
              <FilterPill
                key={tab.value}
                active={selectedStatus === tab.value}
                onClick={() => setSelectedStatus(tab.value)}
              >
                {tab.label}
              </FilterPill>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {cropFilters.map((crop) => (
              <FilterPill
                key={crop}
                active={crop === selectedCrop}
                onClick={() => setSelectedCrop(crop)}
              >
                {crop === "All" ? t("allCrops") : crop}
              </FilterPill>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-700">
                {t("farmersLabel")}
              </p>

              <p className="mt-2 text-3xl font-black text-slate-900">{filteredRows.length}</p>
            </div>

            <div className="rounded-2xl border border-lime-200 bg-lime-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-lime-800">
                {t("nextSlot")}
              </p>

              <p className="mt-2 text-3xl font-black text-slate-900">
                {filteredRows[0]
                  ? formatTime(filteredRows[0].scheduledStartAt, centre.timezone, locale)
                  : t("notAvailableShort")}
              </p>
            </div>
          </div>

          <div className="rounded-[26px] border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xl font-bold text-slate-900">{headerTitle}</h3>
            </div>

            {filteredRows.length === 0 ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-slate-700">
                {selectedStatus === "Active" ? t("noActiveSlots") : t("noClearedSlots")}
              </div>
            ) : (
              filteredRows.map((row, index) => (
                <QueueCard
                  key={row.bookingCode}
                  row={row}
                  isHighlighted={index === 0 && selectedStatus === "Active"}
                  timezone={centre.timezone}
                  locale={locale}
                  t={t}
                  onOpen={() =>
                    navigate("/officer/gate", { state: { bookingCode: row.bookingCode } })
                  }
                />
              ))
            )}
          </div>
        </div>
      )}
    </OfficerLayout>
  );
}

export default OfficerToday;

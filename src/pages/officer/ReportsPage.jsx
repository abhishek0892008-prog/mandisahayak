import { useState } from "react";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import useOfficerCentre from "../../hooks/useOfficerCentre";
import { translateDisplayStatus } from "../../lib/codes";
import { formatDate, formatQuantity, kgToQuintal, todayInZone } from "../../lib/format";
import OfficerLayout from "../../components/OfficerLayout";
import CentrePicker from "../../components/CentrePicker";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/**
 * The day's record.
 *
 * Deliberately a read, and deliberately narrow. `GET /admin/reports/:reportKey`
 * exists for real reporting and belongs to the admin portal; an officer's
 * question is "what happened at my centre today", which the bookings list
 * already answers.
 *
 * Every total here is counted from rows the server returned. Nothing is
 * accumulated in local state across sessions, which is what made the
 * prototype's totals drift.
 */
function ReportsPage() {
  const { t, i18n } = useTranslation();

  const centre = useOfficerCentre();
  const [date, setDate] = useState(null);

  const effectiveDate = date ?? todayInZone(centre.timezone);

  const bookings = useApiResource(
    (signal) => api.centreBookings(centre.centreId, { date: effectiveDate }, signal),
    [centre.centreId, effectiveDate],
    { enabled: Boolean(centre.centreId) },
  );

  const rows = bookings.data ?? [];
  const locale = i18n.language;

  const completed = rows.filter((row) => ["COMPLETED", "PAYMENT_PENDING"].includes(row.status));
  const noShows = rows.filter((row) => row.status === "NO_SHOW");
  const cancelled = rows.filter((row) => row.status === "CANCELLED");

  const declaredKg = rows.reduce((total, row) => total + Number(row.quantityKg ?? 0), 0);

  const byCrop = rows.reduce((map, row) => {
    const name = row.crop?.name ?? "—";
    map[name] = (map[name] ?? 0) + Number(row.quantityKg ?? 0);
    return map;
  }, {});

  return (
    <OfficerLayout
      title={t("reports")}
      subtitle={centre.centre?.name ?? t("procurementCentre")}
      stats={[
        { label: t("expected"), value: rows.length },
        { label: t("completedToday"), value: completed.length },
        { label: t("notAttended"), value: noShows.length },
        { label: t("cancelled"), value: cancelled.length },
      ]}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <CentrePicker centre={centre} />

          <input
            type="date"
            value={effectiveDate}
            onChange={(event) => setDate(event.target.value)}
            className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-600"
          />
        </div>
      }
    >
      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {(centre.loading || bookings.initialLoading) && <Loading />}

      {!bookings.initialLoading && rows.length === 0 && !bookings.error && (
        <EmptyState icon="📊" title={t("noBookingsToday")} description={t("noBookingsTodayNote")} />
      )}

      {rows.length > 0 && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800/80">
                {t("declaredTotal")}
              </p>

              <p className="mt-2 text-3xl font-black text-slate-900">
                {formatQuantity(kgToQuintal(declaredKg), locale)}{" "}
                <span className="text-base font-semibold text-slate-500">{t("quintal")}</span>
              </p>

              {/* Declared, not procured: the accepted figure is per booking and
                  only exists once quality has been recorded. */}
              <p className="mt-1 text-xs text-slate-400">{t("declaredTotalNote")}</p>
            </div>

            <div className="rounded-2xl border border-emerald-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800/80">
                {t("byCrop")}
              </p>

              <ul className="mt-2 space-y-1">
                {Object.entries(byCrop).map(([crop, kg]) => (
                  <li key={crop} className="flex justify-between text-sm">
                    <span className="text-slate-700">{crop}</span>

                    <span className="font-semibold text-slate-900">
                      {formatQuantity(kgToQuintal(kg), locale)} {t("quintal")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-emerald-100 text-left text-xs uppercase tracking-wide text-emerald-800/80">
                  <th className="px-3 py-3">{t("tokenNumberLabel")}</th>
                  <th className="px-3 py-3">{t("bookingCode")}</th>
                  <th className="px-3 py-3">{t("crop")}</th>
                  <th className="px-3 py-3">{t("quantity")}</th>
                  <th className="px-3 py-3">{t("date")}</th>
                  <th className="px-3 py-3">{t("statusLabel")}</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => (
                  <tr key={row.bookingCode} className="border-b border-slate-100">
                    <td className="px-3 py-3 font-black text-slate-900">{row.tokenNumber}</td>

                    <td className="px-3 py-3 font-mono text-xs text-slate-500">
                      {row.bookingCode}
                    </td>

                    <td className="px-3 py-3 text-slate-800">{row.crop?.name}</td>

                    <td className="px-3 py-3 text-slate-800">
                      {formatQuantity(kgToQuintal(row.quantityKg), locale)} {t("quintal")}
                    </td>

                    <td className="px-3 py-3 text-slate-800">
                      {formatDate(row.serviceDate, centre.timezone, locale)}
                    </td>

                    <td className="px-3 py-3">
                      <StatusBadge
                        status={row.status}
                        label={translateDisplayStatus(t, row.displayStatus)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </OfficerLayout>
  );
}

export default ReportsPage;

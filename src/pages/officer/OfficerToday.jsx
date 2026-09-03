import { useState } from "react";
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

/**
 * Today at this centre.
 *
 * Replaces the prototype's "morning setup" dashboard, which mixed two
 * different jobs: looking at today's work (an officer's) and configuring the
 * centre — operating hours, slot capacity, accepted crops, MSP rates (an
 * admin's, and served by `/admin/centres/*`). Configuration lives in the admin
 * portal now; this screen shows the day.
 *
 * The date defaults to today IN THE CENTRE'S TIMEZONE, which is what the
 * endpoint does when no date is supplied.
 */
function OfficerToday() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

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

  const countOf = (...statuses) =>
    rows.filter((row) => statuses.includes(row.status)).length;

  const stats = [
    { label: t("expected"), value: rows.length },
    { label: t("arrived"), value: countOf("ARRIVED", "WEIGHING", "QUALITY_CHECK") },
    { label: t("completedToday"), value: countOf("COMPLETED", "PAYMENT_PENDING") },
    { label: t("notAttended"), value: countOf("NO_SHOW") },
  ];

  return (
    <OfficerLayout
      title={t("officerToday")}
      subtitle={centre.centre?.name ?? t("procurementCentre")}
      stats={stats}
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-emerald-100 text-left text-xs uppercase tracking-wide text-emerald-800/80">
                <th className="px-3 py-3">{t("tokenNumberLabel")}</th>
                <th className="px-3 py-3">{t("bookingCode")}</th>
                <th className="px-3 py-3">{t("crop")}</th>
                <th className="px-3 py-3">{t("quantity")}</th>
                <th className="px-3 py-3">{t("arriveBy")}</th>
                <th className="px-3 py-3">{t("lane")}</th>
                <th className="px-3 py-3">{t("statusLabel")}</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row.bookingCode} className="border-b border-slate-100 hover:bg-emerald-50/40">
                  <td className="px-3 py-3 text-lg font-black text-slate-900">{row.tokenNumber}</td>

                  <td className="px-3 py-3 font-mono text-xs text-slate-500">{row.bookingCode}</td>

                  <td className="px-3 py-3 text-slate-800">{row.crop?.name}</td>

                  <td className="px-3 py-3 text-slate-800">
                    {formatQuantity(kgToQuintal(row.quantityKg), locale)} {t("quintal")}
                  </td>

                  <td className="px-3 py-3 text-slate-800">
                    {formatTime(row.scheduledStartAt, centre.timezone, locale)}
                  </td>

                  <td className="px-3 py-3 text-slate-800">{row.laneNo}</td>

                  <td className="px-3 py-3">
                    <StatusBadge
                      status={row.status}
                      label={translateDisplayStatus(t, row.displayStatus)}
                    />
                  </td>

                  <td className="px-3 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        navigate("/officer/gate", { state: { bookingCode: row.bookingCode } })
                      }
                      className="rounded-full border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
                    >
                      {t("open")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </OfficerLayout>
  );
}

export default OfficerToday;

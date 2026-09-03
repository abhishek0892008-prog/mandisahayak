import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import {
  ACTIVE_BOOKING_STATUSES,
  translateDisplayStatus,
  translateEtaConfidence,
  translateEtaReason,
  translateQueueState,
} from "../../lib/codes";
import { formatMinutes, formatTime } from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/** Fallback cadence, used only until the server states its own. */
const DEFAULT_POLL_SECONDS = 10;

/**
 * Live queue position and ETA.
 *
 * Every number the prototype showed here was a literal — token FQ-0284,
 * position 18, 17 ahead, 35 minutes. All of it now comes from
 * `GET /bookings/:code/queue`, refreshed at the cadence the server dictates
 * through `pollAfterSeconds` rather than a hardcoded interval (queue.md §5).
 *
 * Position and ETA are presented as different kinds of claim, because they
 * are: position is exact, an ETA is a projection and always carries the
 * confidence it was computed at (queue.md §2).
 */
function QueueStatus() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [selected, setSelected] = useState(location.state?.bookingCode ?? null);

  const bookings = useApiResource((signal) => api.myBookings(false, signal), []);

  const active = (bookings.data ?? []).filter((booking) =>
    ACTIVE_BOOKING_STATUSES.has(booking.status),
  );

  // Default to the booking starting soonest; let the farmer switch when they
  // have more than one open.
  const bookingCode =
    selected ??
    [...active].sort((a, b) => new Date(a.scheduledStartAt) - new Date(b.scheduledStartAt))[0]
      ?.bookingCode ??
    null;

  const [pollSeconds, setPollSeconds] = useState(DEFAULT_POLL_SECONDS);

  const queue = useApiResource(
    async (signal) => {
      const result = await api.queue(bookingCode, signal);

      // Cadence is an operational decision the server owns, so adopt whatever
      // it just told us rather than keeping a constant in the UI.
      if (typeof result?.pollAfterSeconds === "number" && result.pollAfterSeconds > 0) {
        setPollSeconds(Math.max(3, result.pollAfterSeconds));
      }

      return result;
    },
    [bookingCode],
    { enabled: Boolean(bookingCode), intervalMs: pollSeconds * 1000 },
  );

  const data = queue.data;
  const locale = i18n.language;
  const minuteLabels = { hour: t("hoursShort"), minute: t("minutesShort") };

  return (
    <FarmerLayout
      title={t("queueStatus")}
      subtitle={t("viewYourPosition")}
      onBack={() => navigate("/dashboard")}
    >
      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {bookings.initialLoading && <Loading />}

      {!bookings.initialLoading && !bookingCode && !bookings.error && (
        <EmptyState
          icon="🕐"
          title={t("noActiveBooking")}
          description={t("noActiveBookingDescription")}
          action={
            <button
              type="button"
              onClick={() => navigate("/book-slot")}
              className="mt-5 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white"
            >
              {t("bookSlot")} →
            </button>
          }
        />
      )}

      {active.length > 1 && (
        <div className="mb-4">
          <label htmlFor="bookingSelect" className="block text-sm font-medium text-slate-700">
            {t("selectBooking")}
          </label>

          <select
            id="bookingSelect"
            value={bookingCode ?? ""}
            onChange={(event) => setSelected(event.target.value)}
            className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-green-600"
          >
            {active.map((booking) => (
              <option key={booking.bookingCode} value={booking.bookingCode}>
                {booking.bookingCode} — {booking.centre?.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {queue.error && <ErrorState error={queue.error} onRetry={queue.reload} />}

      {bookingCode && queue.initialLoading && <Loading />}

      {data && (
        <>
          <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-green-700 to-green-600 p-5 text-white shadow-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-green-100">
                  {t("tokenNumberLabel")}
                </p>

                <p className="mt-1 text-3xl font-bold">{data.tokenNumber}</p>

                <p className="mt-1 text-xs text-green-100">{data.bookingCode}</p>
              </div>

              <span className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold">
                {translateDisplayStatus(t, data.displayStatus)}
              </span>
            </div>

            {data.inQueue ? (
              <div className="mt-5 grid grid-cols-3 gap-2">
                <div className="rounded-2xl bg-white/10 p-3 text-center">
                  <p className="text-xs text-green-100">{t("yourPosition")}</p>
                  <p className="mt-1 text-2xl font-bold">#{data.queuePosition}</p>
                </div>

                {/* Both "ahead" numbers are shown because one alone misleads:
                    the lane figure predicts the wait, the centre figure is what
                    a farmer means by "how many are in front of me"
                    (queue.md §4.1). */}
                <div className="rounded-2xl bg-white/10 p-3 text-center">
                  <p className="text-xs text-green-100">{t("aheadOnLane")}</p>
                  <p className="mt-1 text-2xl font-bold">{data.aheadOnLane}</p>
                </div>

                <div className="rounded-2xl bg-white/10 p-3 text-center">
                  <p className="text-xs text-green-100">{t("aheadAtCentre")}</p>
                  <p className="mt-1 text-2xl font-bold">{data.aheadAtCentre}</p>
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-2xl bg-white/10 p-4">
                <p className="text-sm font-semibold">{t("notInQueue")}</p>
                <p className="mt-1 text-xs text-green-100">{t("notInQueueDescription")}</p>
              </div>
            )}
          </section>

          {/* An ETA is an estimate with a stated basis, never a promise. When
              the server says UNAVAILABLE it explains why instead of showing a
              number. */}
          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-slate-900">{t("estimatedWait")}</h2>

              <StatusBadge
                status={data.etaConfidence === "UNAVAILABLE" ? "UNKNOWN" : "CONFIRMED"}
                label={translateEtaConfidence(t, data.etaConfidence)}
              />
            </div>

            {data.etaConfidence === "UNAVAILABLE" ? (
              <p className="mt-3 text-sm leading-5 text-slate-500">
                {translateEtaReason(t, data.etaUnavailableReason)}
              </p>
            ) : (
              <>
                <p className="mt-3 text-3xl font-bold text-slate-900">
                  {typeof data.estimatedWaitMinutes === "number"
                    ? formatMinutes(data.estimatedWaitMinutes, locale, minuteLabels)
                    : "—"}
                </p>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-slate-500">{t("estimatedStart")}</p>
                    <p className="font-medium text-slate-800">
                      {formatTime(data.estimatedStartAt, data.centreTimezone, locale) ?? "—"}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-slate-500">{t("lane")}</p>
                    <p className="font-medium text-slate-800">
                      {data.laneNo} / {data.laneCount}
                    </p>
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-slate-500">{t("nowServing")}</span>

              <span className="text-sm font-semibold text-slate-900">
                {data.currentlyServingToken ?? t("laneIdle")}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <span className="text-sm text-slate-500">{t("queueStatus")}</span>

              <span className="text-sm font-semibold text-slate-900">
                {translateQueueState(t, data.queueState)}
              </span>
            </div>
          </section>

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              {t("queueUpdatedAt", {
                time: formatTime(data.observedAt, data.centreTimezone, locale) ?? "—",
              })}
            </p>

            <button
              type="button"
              onClick={queue.reload}
              className="text-sm font-semibold text-green-700 hover:underline"
            >
              {t("refresh")}
            </button>
          </div>

          {data.etaBasis && (
            <details className="mt-3 rounded-2xl bg-white p-4 text-sm shadow-sm">
              <summary className="cursor-pointer font-medium text-slate-700">
                {t("etaBasisLabel")}
              </summary>

              <p className="mt-2 leading-5 text-slate-500">{data.etaBasis}</p>
            </details>
          )}
        </>
      )}
    </FarmerLayout>
  );
}

export default QueueStatus;

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import {
  ACTIVE_BOOKING_STATUSES,
  translateDisplayStatus,
  translateError,
} from "../../lib/codes";
import { formatDate, formatQuantity, formatTimeRange, kgToQuintal } from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import {
  DataTypeNote,
  EmptyState,
  ErrorState,
  Loading,
  StatusBadge,
} from "../../components/StateViews";

/**
 * Bookings list, active and past.
 *
 * Cancellation is a server decision: the cutoff comes from
 * `cancellation_cutoff_hours` and the transition is validated in the same
 * transaction that writes the audit record (bookings.md §8). The client shows
 * the button and reports what came back — it does not decide eligibility, and
 * it never mutates a local array to fake the result.
 */
function MyBooking() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [showHistory, setShowHistory] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const [notice, setNotice] = useState(null);

  const bookings = useApiResource(
    (signal) => api.myBookings(showHistory, signal),
    [showHistory],
  );

  const locale = i18n.language;
  const all = bookings.data ?? [];

  const active = all.filter((booking) => ACTIVE_BOOKING_STATUSES.has(booking.status));
  const past = all.filter((booking) => !ACTIVE_BOOKING_STATUSES.has(booking.status));

  async function handleCancel() {
    if (!confirming) return;

    setCancelling(true);
    setCancelError(null);

    try {
      await api.cancelBooking(confirming.bookingCode, reason.trim() || undefined);

      setConfirming(null);
      setReason("");
      setNotice(t("bookingCancelled"));

      // Refetch rather than splicing the local array: the server owns the
      // resulting status, and a cancelled booking may change what else is
      // shown.
      bookings.reload();
    } catch (error) {
      setCancelError(error);
    } finally {
      setCancelling(false);
    }
  }

  function renderBooking(booking) {
    const zone = booking.centre?.timezone;
    const cancellable = booking.status === "CONFIRMED";

    return (
      <article key={booking.bookingCode} className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900">{booking.centre?.name}</h3>
            <p className="mt-0.5 text-xs text-slate-400">{booking.bookingCode}</p>
          </div>

          <StatusBadge
            status={booking.status}
            label={translateDisplayStatus(t, booking.displayStatus)}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-slate-500">{t("crop")}</p>
            <p className="font-medium text-slate-800">{booking.crop?.name}</p>
          </div>

          <div>
            <p className="text-xs text-slate-500">{t("quantity")}</p>
            <p className="font-medium text-slate-800">
              {formatQuantity(kgToQuintal(booking.quantityKg), locale)} {t("quintal")}
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-500">{t("date")}</p>
            <p className="font-medium text-slate-800">
              {formatDate(booking.serviceDate, zone, locale)}
            </p>
          </div>

          <div>
            <p className="text-xs text-slate-500">{t("tokenNumberLabel")}</p>
            <p className="font-medium text-slate-800">{booking.tokenNumber ?? "—"}</p>
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-slate-50 p-3">
          <p className="text-xs text-slate-500">{t("arriveBy")}</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">
            {formatTimeRange(booking.scheduledStartAt, booking.processingEndAt, zone, locale) ?? "—"}
          </p>
        </div>

        <DataTypeNote dataType={booking.centre?.dataType} />

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigate("/queue", { state: { bookingCode: booking.bookingCode } })}
            className="flex-1 rounded-xl bg-green-700 px-3 py-2.5 text-xs font-semibold text-white"
          >
            {t("queueStatus")}
          </button>

          <button
            type="button"
            onClick={() =>
              navigate("/procurement", { state: { bookingCode: booking.bookingCode } })
            }
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-700"
          >
            {t("procurement")}
          </button>

          {cancellable && (
            <button
              type="button"
              onClick={() => {
                setConfirming(booking);
                setCancelError(null);
                setReason("");
              }}
              className="flex-1 rounded-xl border border-red-200 px-3 py-2.5 text-xs font-semibold text-red-700"
            >
              {t("cancelBooking")}
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <FarmerLayout
      title={t("myBooking")}
      subtitle={t("slotDetails")}
      onBack={() => navigate("/dashboard")}
    >
      {notice && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {bookings.initialLoading && <Loading />}

      {!bookings.initialLoading && !bookings.error && (
        <>
          {active.length === 0 && past.length === 0 ? (
            <EmptyState
              icon="🎟️"
              title={t("noBookingsYet")}
              description={t("noBookingsDescription")}
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
          ) : (
            <div className="space-y-3">
              {active.length > 0 && (
                <h2 className="text-sm font-semibold text-slate-500">{t("activeBookings")}</h2>
              )}

              {active.map(renderBooking)}

              {showHistory && past.length > 0 && (
                <>
                  <h2 className="pt-3 text-sm font-semibold text-slate-500">{t("pastBookings")}</h2>
                  {past.map(renderBooking)}
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700"
          >
            {showHistory ? t("hideHistory") : t("showHistory")}
          </button>
        </>
      )}

      {/* Cancellation confirmation ---------------------------------- */}
      {confirming && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">{t("cancelBookingConfirm")}</h3>

            <p className="mt-1 text-sm text-slate-500">{t("cancelBookingWarning")}</p>

            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
              {confirming.bookingCode}
            </p>

            <label htmlFor="cancelReason" className="mt-4 block text-sm font-medium text-slate-700">
              {t("cancelReason")}
            </label>

            <input
              id="cancelReason"
              type="text"
              value={reason}
              maxLength={280}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("cancelReasonPlaceholder")}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-green-600"
            />

            {cancelError && <ErrorState error={cancelError} className="mt-3" />}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={cancelling}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"
              >
                {t("keepBooking")}
              </button>

              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:bg-red-300"
              >
                {cancelling ? t("cancelling") : t("cancelBooking")}
              </button>
            </div>

            {cancelError && (
              <p className="mt-2 text-center text-xs text-slate-400">
                {translateError(t, cancelError)}
              </p>
            )}
          </div>
        </div>
      )}
    </FarmerLayout>
  );
}

export default MyBooking;

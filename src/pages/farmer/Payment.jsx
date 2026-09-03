import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { ApiError } from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import { translatePaymentBlocked, translatePaymentStatus } from "../../lib/codes";
import { formatDateTime, formatPaisePerQuintal, formatRupees } from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import { DetailRow, EmptyState, ErrorState, Loading } from "../../components/StateViews";

/**
 * Payment status for one booking.
 *
 * The amount is computed in PostgreSQL `numeric` against an MSP rate
 * snapshotted at the moment of computation, and arrives as both integer paise
 * and an exact decimal string. The browser formats it and nothing more —
 * re-deriving an amount here in floating point would reintroduce exactly the
 * error the backend takes care to avoid.
 *
 * When a payment cannot be priced the server returns a reason instead of a
 * number, and that reason is shown rather than hidden behind a zero.
 */
function Payment() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [selected, setSelected] = useState(location.state?.bookingCode ?? null);

  const bookings = useApiResource((signal) => api.myBookings(true, signal), []);

  const all = bookings.data ?? [];

  const bookingCode =
    selected ??
    [...all].sort((a, b) => new Date(b.scheduledStartAt) - new Date(a.scheduledStartAt))[0]
      ?.bookingCode ??
    null;

  const record = useApiResource(
    (signal) => api.payment(bookingCode, signal),
    [bookingCode],
    { enabled: Boolean(bookingCode) },
  );

  const locale = i18n.language;
  const booking = all.find((item) => item.bookingCode === bookingCode) ?? null;

  // No payment row exists until procurement completes; that is a state, not a
  // fault.
  const notReady = record.error instanceof ApiError && record.error.status === 404;
  const payment = record.data?.payment ?? null;

  const blocked = payment?.status === "BLOCKED" || payment?.status === "ON_HOLD";

  return (
    <FarmerLayout
      title={t("payment")}
      subtitle={t("paymentDescription")}
      onBack={() => navigate("/dashboard")}
    >
      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {bookings.initialLoading && <Loading />}

      {!bookings.initialLoading && !bookingCode && !bookings.error && (
        <EmptyState
          icon="💳"
          title={t("noBookingsYet")}
          description={t("paymentBookingRequired")}
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

      {all.length > 1 && (
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
            {all.map((item) => (
              <option key={item.bookingCode} value={item.bookingCode}>
                {item.bookingCode} — {item.crop?.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {bookingCode && record.initialLoading && <Loading />}

      {notReady && (
        <EmptyState
          icon="⏳"
          title={t("paymentNotAvailable")}
          description={t("paymentNotAvailableDescription")}
        />
      )}

      {record.error && !notReady && <ErrorState error={record.error} onRetry={record.reload} />}

      {payment && (
        <>
          <section
            className={`overflow-hidden rounded-3xl p-5 text-white shadow-lg ${
              payment.status === "PAID"
                ? "bg-gradient-to-br from-green-700 to-green-600"
                : blocked
                  ? "bg-gradient-to-br from-amber-600 to-amber-500"
                  : "bg-gradient-to-br from-slate-700 to-slate-600"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-white/80">
                  {t("amountPayable")}
                </p>

                <p className="mt-1 text-3xl font-bold">
                  {payment.amountRupees === null
                    ? "—"
                    : formatRupees(payment.amountRupees, locale)}
                </p>

                {booking && <p className="mt-1 text-xs text-white/80">{booking.bookingCode}</p>}
              </div>

              <span className="shrink-0 rounded-full bg-white/20 px-3 py-1.5 text-xs font-semibold">
                {translatePaymentStatus(t, payment.status)}
              </span>
            </div>
          </section>

          {/* The blocked reason is shown, not hidden: a farmer is entitled to
              know why their produce cannot be priced yet. */}
          {blocked && (
            <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <h2 className="font-semibold text-amber-900">{t("paymentBlockedTitle")}</h2>

              <p className="mt-1 text-sm leading-5 text-amber-800">
                {translatePaymentBlocked(t, payment.blockedReason)}
              </p>
            </section>
          )}

          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <h2 className="font-semibold text-slate-900">{t("paymentInformation")}</h2>

            <div className="mt-2 divide-y divide-slate-100">
              <DetailRow
                label={t("ratePerQuintal")}
                value={
                  payment.ratePerQuintalPaise === null
                    ? null
                    : formatPaisePerQuintal(payment.ratePerQuintalPaise, locale)
                }
              />

              <DetailRow
                label={t("baseAmount")}
                value={
                  payment.baseAmountPaise === null
                    ? null
                    : formatRupees(payment.baseAmountPaise / 100, locale)
                }
              />

              <DetailRow
                label={t("deductions")}
                value={
                  payment.deductionsPaise
                    ? formatRupees(payment.deductionsPaise / 100, locale)
                    : formatRupees(0, locale)
                }
              />

              <DetailRow
                label={t("amountPayable")}
                emphasis
                value={
                  payment.amountRupees === null
                    ? null
                    : formatRupees(payment.amountRupees, locale)
                }
              />

              <DetailRow label={t("paymentReference")} value={payment.paymentReference} />

              <DetailRow
                label={t("paidOn")}
                value={formatDateTime(payment.paidAt, booking?.centre?.timezone, locale)}
              />
            </div>
          </section>

          {/* FarmQueue tracks payment status; it does not disburse. Saying so
              on the screen keeps the UI's claim identical to the project's. */}
          <p className="mt-4 rounded-xl bg-slate-100 p-3 text-xs leading-4 text-slate-500">
            ℹ️ {t("noDisbursalNote")}
          </p>

          <button
            type="button"
            onClick={() => navigate("/procurement", { state: { bookingCode } })}
            className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700"
          >
            {t("viewProcurementStatus")}
          </button>
        </>
      )}
    </FarmerLayout>
  );
}

export default Payment;

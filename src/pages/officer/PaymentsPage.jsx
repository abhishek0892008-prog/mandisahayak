import { useState } from "react";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import useOfficerCentre from "../../hooks/useOfficerCentre";
import { translateDisplayStatus, translatePaymentStatus } from "../../lib/codes";
import { formatDate, todayInZone } from "../../lib/format";
import OfficerLayout from "../../components/OfficerLayout";
import CentrePicker from "../../components/CentrePicker";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/**
 * Payment status.
 *
 * The transitions are a state machine the server enforces (officer.md §5.4),
 * so the UI offers only the moves that are legal from the current status
 * rather than a free dropdown that would collect a 409.
 *
 * `PAID` requires a reference, and only `PAID` closes the booking — FAILED and
 * ON_HOLD leave it PAYMENT_PENDING, because the work is not finished. A
 * BLOCKED payment has no outgoing edge at all: unblocking needs an MSP import
 * or a grade correction, which are administrative acts.
 *
 * FarmQueue records status. It does not move money.
 */
const NEXT_STATUSES = {
  PENDING: ["INITIATED", "ON_HOLD", "FAILED"],
  INITIATED: ["PAID", "FAILED", "ON_HOLD"],
  ON_HOLD: ["PENDING", "INITIATED", "FAILED"],
  FAILED: ["PENDING", "INITIATED"],
  PAID: [],
  BLOCKED: [],
};

function PaymentsPage() {
  const { t, i18n } = useTranslation();

  const centre = useOfficerCentre();
  const [date, setDate] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reference, setReference] = useState({});

  const effectiveDate = date ?? todayInZone(centre.timezone);

  const bookings = useApiResource(
    (signal) =>
      api.centreBookings(
        centre.centreId,
        { date: effectiveDate, status: "PAYMENT_PENDING,COMPLETED" },
        signal,
      ),
    [centre.centreId, effectiveDate],
    { enabled: Boolean(centre.centreId) },
  );

  const rows = bookings.data?.bookings ?? [];
  const locale = i18n.language;

  async function setStatus(bookingCode, status) {
    setBusy(`${bookingCode}:${status}`);
    setError(null);

    try {
      await api.officerSetPaymentStatus(bookingCode, status, reference[bookingCode]?.trim() || undefined);
      bookings.reload();
    } catch (updateError) {
      setError(updateError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <OfficerLayout
      title={t("payments")}
      subtitle={centre.centre?.name ?? t("procurementCentre")}
      stats={[
        { label: t("awaitingPayment"), value: rows.filter((r) => r.status === "PAYMENT_PENDING").length },
        { label: t("completedToday"), value: rows.filter((r) => r.status === "COMPLETED").length },
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
      {error && <ErrorState error={error} className="mb-4" />}

      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {(centre.loading || bookings.initialLoading) && <Loading />}

      {!bookings.initialLoading && rows.length === 0 && !bookings.error && (
        <EmptyState icon="💳" title={t("noPaymentsToday")} description={t("noPaymentsTodayNote")} />
      )}

      <div className="space-y-4">
        {rows.map((row) => (
          <PaymentRow
            key={row.bookingCode}
            row={row}
            locale={locale}
            timezone={centre.timezone}
            busy={busy}
            reference={reference[row.bookingCode] ?? ""}
            onReference={(value) =>
              setReference((current) => ({ ...current, [row.bookingCode]: value }))
            }
            onSetStatus={setStatus}
          />
        ))}
      </div>

      <p className="mt-6 rounded-xl bg-slate-100 p-3 text-xs leading-4 text-slate-500">
        ℹ️ {t("noDisbursalNote")}
      </p>
    </OfficerLayout>
  );
}

/** One booking's payment, with its own fetch so a row refreshes independently. */
function PaymentRow({ row, locale, timezone, busy, reference, onReference, onSetStatus }) {
  const { t } = useTranslation();

  const detail = useApiResource(
    (signal) => api.payment(row.bookingCode, signal),
    [row.bookingCode],
  );

  const payment = detail.data?.payment ?? null;
  const options = payment ? (NEXT_STATUSES[payment.status] ?? []) : [];
  const needsReference = options.includes("PAID");

  return (
    <article className="rounded-[26px] border border-emerald-100 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-slate-500">{row.bookingCode}</p>

          <h3 className="text-lg font-black text-slate-900">
            {t("tokenNumberLabel")} {row.tokenNumber} · {row.crop?.name}
          </h3>

          <p className="mt-1 text-xs text-slate-500">
            {formatDate(row.serviceDate, timezone, locale)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={row.status} label={translateDisplayStatus(t, row.displayStatus)} />

          {payment && (
            <StatusBadge
              status={payment.status}
              label={translatePaymentStatus(t, payment.status)}
            />
          )}
        </div>
      </div>

      {detail.initialLoading && <Loading />}

      {payment && (
        <>
          <p className="mt-3 text-2xl font-black text-slate-900">
            {payment.amountRupees
              ? new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", {
                  style: "currency",
                  currency: "INR",
                }).format(Number(payment.amountRupees))
              : "—"}
          </p>

          {payment.paymentReference && (
            <p className="mt-1 text-xs text-slate-500">
              {t("paymentReference")}: {payment.paymentReference}
            </p>
          )}

          {needsReference && (
            <input
              type="text"
              value={reference}
              onChange={(event) => onReference(event.target.value)}
              placeholder={t("paymentReferencePlaceholder")}
              aria-label={t("paymentReference")}
              className="mt-3 w-full max-w-sm rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600"
            />
          )}

          {options.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {options.map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={
                    busy === `${row.bookingCode}:${status}` ||
                    (status === "PAID" && !reference.trim())
                  }
                  onClick={() => onSetStatus(row.bookingCode, status)}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${
                    status === "PAID"
                      ? "bg-emerald-700 text-white hover:bg-emerald-800"
                      : "border border-emerald-200 text-emerald-800 hover:bg-emerald-50"
                  }`}
                >
                  {translatePaymentStatus(t, status)}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              {payment.status === "BLOCKED" ? t("paymentBlockedNoAction") : t("paymentFinal")}
            </p>
          )}
        </>
      )}
    </article>
  );
}

export default PaymentsPage;

import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { ApiError } from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import {
  translateDisplayStatus,
  translatePaymentStatus,
  translateProcurementStatus,
  translateQualityStatus,
} from "../../lib/codes";
import {
  formatDateTime,
  formatQuantity,
  kgToQuintal,
} from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import {
  DetailRow,
  EmptyState,
  ErrorState,
  Loading,
  StatusBadge,
} from "../../components/StateViews";

function Procurement() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [selected, setSelected] = useState(
    location.state?.bookingCode ?? null,
  );

  const bookings = useApiResource(
    (signal) => api.myBookings(true, signal),
    [],
  );

  const all = bookings.data ?? [];

  const bookingCode =
    selected ??
    [...all].sort(
      (a, b) =>
        new Date(b.scheduledStartAt) -
        new Date(a.scheduledStartAt),
    )[0]?.bookingCode ??
    null;

  const record = useApiResource(
    (signal) => api.procurement(bookingCode, signal),
    [bookingCode],
    { enabled: Boolean(bookingCode) },
  );

  const locale = i18n.language;

  const booking =
    all.find((item) => item.bookingCode === bookingCode) ?? null;

  const notStarted =
    record.error instanceof ApiError &&
    record.error.status === 404;

  const procurement = record.data?.procurement ?? null;
  const payment = record.data?.payment ?? null;

  const quintal = (kg) =>
    kg === null || kg === undefined
      ? null
      : kgToQuintal(kg);

  return (
    <FarmerLayout
      title={t("procurement")}
      subtitle={t("trackProgress")}
      onBack={() => navigate("/dashboard")}
    >
      {bookings.error && (
        <ErrorState
          error={bookings.error}
          onRetry={bookings.reload}
        />
      )}

      {bookings.initialLoading && <Loading />}

      {!bookings.initialLoading &&
        !bookingCode &&
        !bookings.error && (
          <EmptyState
            icon="🌾"
            title={t("noBookingsYet")}
            description={t("noBookingsDescription")}
            action={
              <button
                type="button"
                onClick={() => navigate("/book-slot")}
                className="mt-5 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-800"
              >
                {t("bookSlot")} →
              </button>
            }
          />
        )}

      {all.length > 1 && (
        <div className="mb-4">
          <label
            htmlFor="bookingSelect"
            className="block text-sm font-medium text-slate-700"
          >
            {t("selectBooking")}
          </label>

          <select
            id="bookingSelect"
            value={bookingCode ?? ""}
            onChange={(event) =>
              setSelected(event.target.value)
            }
            className="mt-1 min-h-12 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-green-600 focus:ring-4 focus:ring-green-50"
          >
            {all.map((item) => (
              <option
                key={item.bookingCode}
                value={item.bookingCode}
              >
                {item.bookingCode} — {item.crop?.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {booking && (
        <section className="mb-4 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-slate-900">
                {booking.centre?.name}
              </h2>

              <p className="mt-0.5 text-xs text-slate-400">
                {booking.bookingCode}
              </p>
            </div>

            <StatusBadge
              status={booking.status}
              label={translateDisplayStatus(
                t,
                booking.displayStatus,
              )}
            />
          </div>
        </section>
      )}

      {bookingCode && record.initialLoading && <Loading />}

      {notStarted && (
        <EmptyState
          icon="⏳"
          title={t("procurementNotStarted")}
          description={t(
            "procurementNotStartedDescription",
          )}
        />
      )}

      {record.error && !notStarted && (
        <ErrorState
          error={record.error}
          onRetry={record.reload}
        />
      )}

      {procurement && (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold text-slate-900">
                {t("procurement")}
              </h2>

              <StatusBadge
                status={procurement.status}
                label={translateProcurementStatus(
                  t,
                  procurement.status,
                )}
              />
            </div>

            <div className="mt-2 divide-y divide-slate-100">
              <DetailRow
                label={t("qualityResult")}
                value={translateQualityStatus(
                  t,
                  procurement.qualityStatus,
                )}
              />

              <DetailRow
                label={t("grossQuantity")}
                value={
                  procurement.grossQuantityKg === null
                    ? null
                    : `${formatQuantity(
                        quintal(
                          procurement.grossQuantityKg,
                        ),
                        locale,
                      )} ${t("quintal")}`
                }
              />

              <DetailRow
                label={t("acceptedQuantity")}
                emphasis
                value={
                  procurement.acceptedQuantityKg === null
                    ? null
                    : `${formatQuantity(
                        quintal(
                          procurement.acceptedQuantityKg,
                        ),
                        locale,
                      )} ${t("quintal")}`
                }
              />

              <DetailRow
                label={t("rejectedQuantity")}
                value={
                  procurement.rejectedQuantityKg === null
                    ? null
                    : `${formatQuantity(
                        quintal(
                          procurement.rejectedQuantityKg,
                        ),
                        locale,
                      )} ${t("quintal")}`
                }
              />

              <DetailRow
                label={t("grade")}
                value={procurement.grade}
              />

              <DetailRow
                label={t("moisture")}
                value={
                  procurement.moisturePercent === null
                    ? null
                    : `${formatQuantity(
                        procurement.moisturePercent,
                        locale,
                      )}%`
                }
              />

              {procurement.rejectionReason && (
                <DetailRow
                  label={t("rejectionReason")}
                  value={procurement.rejectionReason}
                />
              )}
            </div>
          </section>

          <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            <h2 className="font-semibold text-slate-900">
              {t("statusLabel")}
            </h2>

            <div className="mt-2 divide-y divide-slate-100">
              <DetailRow
                label={t("arrivedAt")}
                value={formatDateTime(
                  procurement.arrivedAt,
                  booking?.centre?.timezone,
                  locale,
                )}
              />

              <DetailRow
                label={t("serviceStarted")}
                value={formatDateTime(
                  procurement.serviceStartedAt,
                  booking?.centre?.timezone,
                  locale,
                )}
              />

              <DetailRow
                label={t("serviceEnded")}
                value={formatDateTime(
                  procurement.serviceEndedAt,
                  booking?.centre?.timezone,
                  locale,
                )}
              />

              <DetailRow
                label={t("completedAt")}
                value={formatDateTime(
                  procurement.completedAt,
                  booking?.centre?.timezone,
                  locale,
                )}
              />
            </div>
          </section>

          {payment && (
            <button
              type="button"
              onClick={() =>
                navigate("/payment", {
                  state: { bookingCode },
                })
              }
              className="mt-4 flex w-full items-center justify-between rounded-2xl border border-green-100 bg-green-50 px-4 py-4 text-left transition hover:border-green-200 hover:bg-green-100"
            >
              <div>
                <p className="text-xs font-semibold text-green-700">
                  {t("payment")}
                </p>

                <p className="mt-1 text-sm font-medium text-slate-700">
                  {translatePaymentStatus(
                    t,
                    payment.status,
                  )}
                </p>
              </div>

              <span className="text-green-700">→</span>
            </button>
          )}
        </>
      )}
    </FarmerLayout>
  );
}

export default Procurement;
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { useAuth } from "../../auth/context";
import useApiResource from "../../hooks/useApiResource";
import {
  ACTIVE_BOOKING_STATUSES,
  translateDisplayStatus,
  translateEtaConfidence,
} from "../../lib/codes";
import { formatDate, formatMinutes, formatQuantity, formatTimeRange, kgToQuintal } from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import { ErrorState, Loading, StatusBadge } from "../../components/StateViews";

const SERVICES = [
  { path: "/book-slot", icon: "📅", tint: "bg-green-50", title: "bookSlot", body: "bookProcurementSlot" },
  { path: "/my-booking", icon: "🎟️", tint: "bg-blue-50", title: "myBooking", body: "slotDetails" },
  { path: "/queue", icon: "🕐", tint: "bg-orange-50", title: "queueStatus", body: "viewYourPosition" },
  { path: "/procurement", icon: "🌾", tint: "bg-yellow-50", title: "procurement", body: "trackProgress" },
  { path: "/payment", icon: "💳", tint: "bg-purple-50", title: "payment", body: "paymentStatus" },
  { path: "/notifications", icon: "🔔", tint: "bg-red-50", title: "notifications", body: "stayUpdated" },
];

/**
 * Farmer home.
 *
 * Everything shown here is server state: the profile from the session, the
 * booking from `GET /bookings/me`, the queue from `GET /bookings/:code/queue`.
 * The prototype read all three from localStorage, which meant the numbers on
 * this screen were whatever the browser last wrote.
 */
function Dashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { farmer } = useAuth();

  const bookings = useApiResource((signal) => api.myBookings(false, signal), []);
  const unread = useApiResource((signal) => api.unreadCount(signal), []);

  const active = (bookings.data ?? []).filter((booking) =>
    ACTIVE_BOOKING_STATUSES.has(booking.status),
  );

  // The booking that matters now is the one starting soonest.
  const current =
    [...active].sort(
      (a, b) => new Date(a.scheduledStartAt) - new Date(b.scheduledStartAt),
    )[0] ?? null;

  // Queue position is only meaningful for a booking that exists, and it is the
  // server that decides whether that booking is actually in a queue.
  const queue = useApiResource(
    (signal) => api.queue(current.bookingCode, signal),
    [current?.bookingCode],
    { enabled: Boolean(current) },
  );

  const unreadCount = unread.data?.unreadCount ?? 0;
  const locale = i18n.language;
  const zone = current?.centre?.timezone;

  const quantityQuintal = current ? kgToQuintal(current.quantityKg) : null;

  return (
    <FarmerLayout
      title={t("namasteFarmer")}
      headerExtra={
        <div className="mt-5">
          <p className="text-sm text-green-100">{t("welcome")}</p>

          <h2 className="mt-1 text-2xl font-bold">{farmer?.fullName ?? t("farmer")}</h2>

          {farmer?.district?.name && (
            <p className="mt-1 text-sm text-green-100">
              📍 {[farmer.village?.name, farmer.district.name].filter(Boolean).join(", ")}
            </p>
          )}
        </div>
      }
    >
      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {bookings.initialLoading && !bookings.error && <Loading label={t("loadingBooking")} />}

      {!bookings.initialLoading && !bookings.error && current && (
        <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-green-700 to-green-600 text-white shadow-lg">
          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wider text-green-100">
                  {t("currentBooking")}
                </p>

                <h2 className="mt-1 truncate text-xl font-bold">{current.centre?.name}</h2>

                <p className="mt-1 text-xs text-green-100">{current.bookingCode}</p>
              </div>

              <span className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold">
                {translateDisplayStatus(t, current.displayStatus)}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              <div className="rounded-2xl bg-white/10 p-3 text-center">
                <p className="text-xs text-green-100">{t("tokenNumberLabel")}</p>
                <p className="mt-1 text-lg font-bold">{current.tokenNumber ?? "—"}</p>
              </div>

              <div className="rounded-2xl bg-white/10 p-3 text-center">
                <p className="text-xs text-green-100">{t("yourPosition")}</p>
                <p className="mt-1 text-lg font-bold">
                  {queue.data?.inQueue && queue.data?.queuePosition
                    ? `#${queue.data.queuePosition}`
                    : "—"}
                </p>
              </div>

              <div className="rounded-2xl bg-white/10 p-3 text-center">
                <p className="text-xs text-green-100">{t("estimatedWait")}</p>
                <p className="mt-1 text-lg font-bold">
                  {typeof queue.data?.estimatedWaitMinutes === "number"
                    ? formatMinutes(queue.data.estimatedWaitMinutes, locale, {
                        hour: t("hoursShort"),
                        minute: t("minutesShort"),
                      })
                    : "—"}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-white/10 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-green-100">
                    {queue.data?.inQueue && typeof queue.data.aheadAtCentre === "number"
                      ? t("farmersAhead", { count: queue.data.aheadAtCentre })
                      : t("queueStatus")}
                  </p>

                  <p className="mt-1 text-sm font-semibold">
                    {current.crop?.name}
                    {quantityQuintal !== null && (
                      <>
                        {" • "}
                        {formatQuantity(quantityQuintal, locale)} {t("quintal")}
                      </>
                    )}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-xs text-green-100">{t("date")}</p>

                  <p className="mt-1 text-sm font-semibold">
                    {formatDate(current.serviceDate, zone, locale) ?? "—"}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-green-100">
                <span>
                  {formatTimeRange(current.scheduledStartAt, current.processingEndAt, zone, locale) ??
                    "—"}
                </span>

                {queue.data?.etaConfidence && (
                  <span>{translateEtaConfidence(t, queue.data.etaConfidence)}</span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => navigate("/queue")}
              className="mt-4 w-full rounded-xl bg-white px-4 py-3 text-sm font-semibold text-green-700"
            >
              {t("viewQueueStatus")} →
            </button>
          </div>
        </section>
      )}

      {!bookings.initialLoading && !bookings.error && !current && (
        <section className="rounded-3xl bg-white p-6 text-center shadow-sm">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-green-50 text-3xl">
            📅
          </div>

          <h2 className="mt-4 text-lg font-bold text-slate-900">{t("noActiveBooking")}</h2>

          <p className="mt-2 text-sm text-slate-500">{t("noActiveBookingDescription")}</p>

          <button
            type="button"
            onClick={() => navigate("/book-slot")}
            className="mt-5 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white"
          >
            {t("bookSlot")} →
          </button>
        </section>
      )}

      {active.length > 1 && (
        <button
          type="button"
          onClick={() => navigate("/my-booking")}
          className="mt-3 flex w-full items-center justify-between rounded-2xl border border-green-100 bg-green-50 px-4 py-3 text-left"
        >
          <div>
            <p className="text-xs font-semibold text-green-700">
              {active.length} {t("records")}
            </p>

            <p className="mt-1 text-sm font-medium text-slate-700">{t("myBooking")}</p>
          </div>

          <span className="text-green-700">→</span>
        </button>
      )}

      <section className="mt-6">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-900">{t("services")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("chooseWhatYouNeed")}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {SERVICES.map((service) => (
            <button
              key={service.path}
              type="button"
              onClick={() => navigate(service.path)}
              className="relative rounded-2xl bg-white p-4 text-left shadow-sm transition hover:shadow-md active:scale-[0.98]"
            >
              <div
                className={`flex h-11 w-11 items-center justify-center rounded-xl text-xl ${service.tint}`}
              >
                {service.icon}
              </div>

              <h3 className="mt-3 font-semibold text-slate-900">{t(service.title)}</h3>

              <p className="mt-1 text-xs leading-4 text-slate-500">{t(service.body)}</p>

              {service.path === "/notifications" && unreadCount > 0 && (
                <span className="absolute right-3 top-3 rounded-full bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                  {unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-50 text-lg">
            ℹ️
          </div>

          <div className="min-w-0">
            <h3 className="font-semibold text-slate-900">{t("howItWorks")}</h3>

            <p className="mt-1 text-sm leading-5 text-slate-500">{t("bookTrackStayUpdated")}</p>
          </div>
        </div>
      </section>

      {current && (
        <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-sm">
          <StatusBadge
            status={current.status}
            label={translateDisplayStatus(t, current.displayStatus)}
          />

          <button
            type="button"
            onClick={() => {
              bookings.reload();
              queue.reload();
              unread.reload();
            }}
            className="text-sm font-semibold text-green-700 hover:underline"
          >
            {t("refresh")}
          </button>
        </div>
      )}
    </FarmerLayout>
  );
}

export default Dashboard;

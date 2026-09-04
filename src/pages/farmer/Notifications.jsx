import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import { translateNotificationType } from "../../lib/codes";
import { formatDateTime } from "../../lib/format";
import FarmerLayout from "../../components/FarmerLayout";
import {
  EmptyState,
  ErrorState,
  Loading,
} from "../../components/StateViews";
import NotificationPreferences from "../../components/NotificationPreferences";

const ICONS = {
  BOOKING_CONFIRMED: "✅",
  BOOKING_ARRIVED: "📍",
  BOOKING_CANCELLED: "🚫",
  ONE_DAY_REMINDER: "⏰",
  QUEUE_APPROACHING: "🔔",
  TURN_APPROACHING: "🔔",
  PROCUREMENT_COMPLETED: "🌾",
  PAYMENT_UPDATED: "💳",
  PAYMENT_BLOCKED: "⚠️",
  NO_SHOW_RECORDED: "❌",
};

function Notifications() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  const feed = useApiResource(
    (signal) =>
      api.notifications(
        unreadOnly
          ? { unread: "true", limit: 50 }
          : { limit: 50 },
        signal,
      ),
    [unreadOnly],
  );

  const notifications = feed.data?.notifications ?? [];
  const unreadCount = feed.data?.unreadCount ?? 0;
  const locale = i18n.language;

  async function markRead(id) {
    setBusy(id);
    setActionError(null);

    try {
      await api.markNotificationRead(id);
      feed.reload();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }

  async function markAllRead() {
    setBusy("all");
    setActionError(null);

    try {
      await api.markAllNotificationsRead();
      feed.reload();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <FarmerLayout
      title={t("notifications")}
      subtitle={t("stayUpdated")}
      onBack={() => navigate("/dashboard")}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() =>
            setShowPreferences((value) => !value)
          }
          className="text-sm font-semibold text-[#15803d] transition hover:underline"
        >
          {showPreferences
            ? t("backToNotifications")
            : t("notificationPreferences")}
        </button>
      </div>

      {showPreferences && <NotificationPreferences />}

      {!showPreferences && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() =>
                setUnreadOnly((value) => !value)
              }
              className={`rounded-full px-4 py-2 text-xs font-semibold transition ${
                unreadOnly
                  ? "bg-[#15803d] text-white"
                  : "bg-white text-slate-600 shadow-sm"
              }`}
            >
              {unreadOnly
                ? t("showAll")
                : t("unreadOnly")}
              {unreadCount > 0 &&
                !unreadOnly &&
                ` (${unreadCount})`}
            </button>

            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                disabled={busy === "all"}
                className="text-sm font-semibold text-[#15803d] transition hover:underline disabled:text-slate-400"
              >
                {t("markAllRead")}
              </button>
            )}
          </div>

          {actionError && (
            <ErrorState
              error={actionError}
              className="mb-4"
            />
          )}

          {feed.error && (
            <ErrorState
              error={feed.error}
              onRetry={feed.reload}
            />
          )}

          {feed.initialLoading && <Loading />}

          {!feed.initialLoading &&
            !feed.error &&
            notifications.length === 0 && (
              <EmptyState
                icon="🔔"
                title={t("noNotifications")}
                description={t(
                  "noNotificationsDescription",
                )}
              />
            )}

          {!feed.initialLoading &&
            !feed.error &&
            notifications.length > 0 && (
              <div className="space-y-3">
                {notifications.map((item) => (
                  <article
                    key={item.id}
                    className={`rounded-2xl border p-4 shadow-sm transition sm:p-5 ${
                      item.read
                        ? "border-slate-100 bg-white"
                        : "border-green-100 bg-green-50"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-lg shadow-sm">
                        {ICONS[item.type] ?? "🔔"}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-[#15803d]">
                            {translateNotificationType(
                              t,
                              item.type,
                            )}
                          </p>

                          {!item.read && (
                            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[#11a255]" />
                          )}
                        </div>

                        <h3 className="mt-1 font-semibold text-slate-900">
                          {item.title}
                        </h3>

                        <p className="mt-1 text-sm leading-6 text-slate-600">
                          {item.message}
                        </p>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                          <span>
                            {formatDateTime(
                              item.createdAt,
                              undefined,
                              locale,
                            )}
                          </span>

                          {item.bookingCode && (
                            <span>
                              {item.bookingCode}
                            </span>
                          )}
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2">
                          {!item.read && (
                            <button
                              type="button"
                              onClick={() =>
                                markRead(item.id)
                              }
                              disabled={busy === item.id}
                              className="rounded-lg bg-[#15803d] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#166534] disabled:bg-green-300"
                            >
                              {t("markRead")}
                            </button>
                          )}

                          {item.bookingCode && (
                            <button
                              type="button"
                              onClick={() =>
                                navigate("/queue", {
                                  state: {
                                    bookingCode:
                                      item.bookingCode,
                                  },
                                })
                              }
                              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              {t("queueStatus")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

          {notifications.length > 0 && (
            <p className="mt-4 rounded-xl bg-slate-100 p-3 text-xs leading-5 text-slate-500">
              ℹ️ {t("demoDeliveryNote")}
            </p>
          )}
        </>
      )}
    </FarmerLayout>
  );
}

export default Notifications;
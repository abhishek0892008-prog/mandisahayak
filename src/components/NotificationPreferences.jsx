import { useState } from "react";
import { useTranslation } from "react-i18next";

import api from "../lib/api";
import useApiResource from "../hooks/useApiResource";
import { translateNotificationType } from "../lib/codes";
import { ErrorState, Loading } from "./StateViews";

/**
 * Per-event notification preferences.
 *
 * Two facts from the contract shape this screen:
 *
 *  - An ABSENT row means enabled. The server states that explicitly as
 *    `defaultWhenUnset` rather than making the client guess, so the toggle
 *    reads its value from the matching row if one exists and falls back to
 *    that field otherwise.
 *  - A write returns the COMPLETE preference set, so the response replaces
 *    local state instead of being patched into it. That keeps this screen
 *    correct even when a preference interacts with another.
 *
 * Only IN_APP is offered. The SMS channel exists in the schema and the API
 * accepts it, but no SMS is delivered in this build — offering a toggle for a
 * channel that sends nothing would be a false promise.
 */
const CHANNEL = "IN_APP";

const EVENTS = [
  "BOOKING_CONFIRMED",
  "BOOKING_ARRIVED",
  "PROCUREMENT_COMPLETED",
  "PAYMENT_UPDATED",
  "PAYMENT_BLOCKED",
  "BOOKING_CANCELLED",
  "ONE_DAY_REMINDER",
  "NO_SHOW_RECORDED",
];

export function NotificationPreferences() {
  const { t } = useTranslation();

  const [override, setOverride] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const loaded = useApiResource((signal) => api.notificationPreferences(signal), []);

  const data = override ?? loaded.data;

  function isEnabled(event) {
    const rows = data?.preferences ?? [];

    const exact = rows.find((row) => row.channel === CHANNEL && row.event === event);
    if (exact) return exact.enabled;

    const channelWide = rows.find((row) => row.channel === CHANNEL && row.event === null);
    if (channelWide) return channelWide.enabled;

    return data?.defaultWhenUnset !== "DISABLED";
  }

  async function toggle(event) {
    const next = !isEnabled(event);

    setBusy(event);
    setError(null);

    try {
      const updated = await api.setNotificationPreference({
        channel: CHANNEL,
        event,
        enabled: next,
      });

      setOverride(updated);
    } catch (toggleError) {
      setError(toggleError);
    } finally {
      setBusy(null);
    }
  }

  if (loaded.initialLoading) return <Loading />;

  if (loaded.error) return <ErrorState error={loaded.error} onRetry={loaded.reload} />;

  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-900">{t("notificationPreferences")}</h2>

      {data?.note && <p className="mt-1 text-xs leading-4 text-slate-500">{data.note}</p>}

      {error && <ErrorState error={error} className="mt-3" />}

      <ul className="mt-3 divide-y divide-slate-100">
        {EVENTS.map((event) => {
          const enabled = isEnabled(event);

          return (
            <li key={event} className="flex items-center justify-between gap-3 py-3">
              <span className="min-w-0 text-sm text-slate-700">
                {translateNotificationType(t, event)}
              </span>

              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={translateNotificationType(t, event)}
                disabled={busy === event}
                onClick={() => toggle(event)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                  enabled ? "bg-green-600" : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    enabled ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs leading-4 text-slate-400">{t("smsChannelUnavailable")}</p>
    </section>
  );
}

export default NotificationPreferences;

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api, { ApiError } from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import useOfficerCentre from "../../hooks/useOfficerCentre";
import { translateDisplayStatus, translateError } from "../../lib/codes";
import { formatQuantity, formatTime, kgToQuintal } from "../../lib/format";
import OfficerLayout from "../../components/OfficerLayout";
import CentrePicker from "../../components/CentrePicker";
import { DetailRow, EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/**
 * Gate entry: find the farmer, record that they arrived.
 *
 * The prototype searched a local array by token or phone. This calls
 * `GET /officer/bookings/search`, which applies centre scope inside the SQL —
 * so a booking at a centre this officer is not assigned to comes back as
 * `404`, indistinguishable from one that does not exist (officer.md §2).
 *
 * `arrive` takes no body: `arrivedAt` is `now()` from the database, never a
 * time the client supplies.
 */
function GateEntryPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();

  const centre = useOfficerCentre();

  const [query, setQuery] = useState(location.state?.bookingCode ?? "");
  const [submitted, setSubmitted] = useState(location.state?.bookingCode ?? null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);

  const results = useApiResource(
    (signal) => api.officerSearch(submitted, signal),
    [submitted],
    { enabled: Boolean(submitted) },
  );

  const locale = i18n.language;
  // The search endpoint answers { query, count, bookings }. Wrapping that
  // object in an array made it look like a single booking row.
  const rows = results.data?.bookings ?? [];

  const notFound = results.error instanceof ApiError && results.error.status === 404;

  async function act(bookingCode, action) {
    setBusy(`${bookingCode}:${action}`);
    setActionError(null);
    setNotice(null);

    try {
      if (action === "arrive") {
        await api.officerArrive(bookingCode);
        setNotice(t("arrivalRecorded", { code: bookingCode }));
      } else {
        await api.officerNoShow(bookingCode);
        setNotice(t("markedNoShow", { code: bookingCode }));
      }

      results.reload();
    } catch (error) {
      setActionError(error);
    } finally {
      setBusy(null);
    }
  }

  function handleSearch(event) {
    event.preventDefault();
    setActionError(null);
    setNotice(null);
    setSubmitted(query.trim() || null);
  }

  return (
    <OfficerLayout
      title={t("gateEntry")}
      subtitle={centre.centre?.name ?? t("procurementCentre")}
      stats={[{ label: t("results"), value: rows.length }]}
      actions={<CentrePicker centre={centre} />}
    >
      <form
        onSubmit={handleSearch}
        className="mb-5 flex w-full max-w-xl items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 p-2"
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchTokenOrCode")}
          aria-label={t("searchTokenOrCode")}
          className="flex-1 bg-transparent px-3 py-2 text-sm font-medium text-slate-900 outline-none"
        />

        <button
          type="submit"
          className="rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          {t("search")}
        </button>
      </form>

      {notice && (
        <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
          {notice}
        </div>
      )}

      {actionError && <ErrorState error={actionError} className="mb-4" />}

      {!submitted && (
        <EmptyState icon="🔎" title={t("searchToBegin")} description={t("searchToBeginNote")} />
      )}

      {submitted && results.initialLoading && <Loading />}

      {notFound && (
        <EmptyState icon="🤷" title={t("noMatch")} description={t("noMatchNote")} />
      )}

      {results.error && !notFound && <ErrorState error={results.error} onRetry={results.reload} />}

      <div className="space-y-4">
        {rows.map((row) => (
          <article
            key={row.bookingCode}
            className="rounded-[26px] border border-emerald-100 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                  {t("tokenNumberLabel")}
                </p>

                <p className="text-4xl font-black text-slate-900">{row.tokenNumber}</p>

                <p className="mt-1 font-mono text-xs text-slate-500">{row.bookingCode}</p>
              </div>

              <StatusBadge
                status={row.status}
                label={translateDisplayStatus(t, row.displayStatus)}
              />
            </div>

            <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
              <DetailRow label={t("crop")} value={row.crop?.name} />

              <DetailRow
                label={t("quantity")}
                value={`${formatQuantity(kgToQuintal(row.quantityKg), locale)} ${t("quintal")}`}
              />

              <DetailRow
                label={t("arriveBy")}
                value={formatTime(row.scheduledStartAt, centre.timezone, locale)}
              />

              <DetailRow label={t("lane")} value={row.laneNo} />
            </div>

            {/* Only a CONFIRMED booking can be admitted or marked absent. The
                server enforces this; the buttons simply stop offering an action
                that would be refused. */}
            {row.status === "CONFIRMED" ? (
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={busy === `${row.bookingCode}:arrive`}
                  onClick={() => act(row.bookingCode, "arrive")}
                  className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                >
                  {t("recordArrival")}
                </button>

                <button
                  type="button"
                  disabled={busy === `${row.bookingCode}:no-show`}
                  onClick={() => act(row.bookingCode, "no-show")}
                  className="rounded-full border border-red-200 px-5 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {t("markNoShow")}
                </button>
              </div>
            ) : (
              <p className="mt-4 text-xs text-slate-500">
                {t("noGateActionAvailable", {
                  status: translateDisplayStatus(t, row.displayStatus),
                })}
              </p>
            )}
          </article>
        ))}
      </div>

      {results.error && notFound && (
        <p className="mt-4 text-center text-xs text-slate-400">
          {translateError(t, results.error)}
        </p>
      )}
    </OfficerLayout>
  );
}

export default GateEntryPage;

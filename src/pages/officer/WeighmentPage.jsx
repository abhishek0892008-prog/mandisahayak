import { useState } from "react";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import useApiResource from "../../hooks/useApiResource";
import useOfficerCentre from "../../hooks/useOfficerCentre";
import {
  translateDisplayStatus,
  translatePaymentBlocked,
  translatePaymentStatus,
  translateQualityStatus,
} from "../../lib/codes";
import { formatQuantity, formatRupees, kgToQuintal, todayInZone } from "../../lib/format";
import OfficerLayout from "../../components/OfficerLayout";
import CentrePicker from "../../components/CentrePicker";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../../components/StateViews";

/** The lifecycle steps this screen drives, in order. */
const STAGE = {
  ARRIVED: "startWeighing",
  WEIGHING: "recordWeight",
  QUALITY_CHECK: "recordQuality",
  PROCUREMENT_RECORDED: "complete",
};

/**
 * The weighbridge.
 *
 * The prototype computed a net weight in the browser from gross, tare and bag
 * weight, and compared it against the declared quantity to flag a variance.
 * None of that survives: the backend records a single `grossQuantityKg`
 * measurement, then accepted/rejected quantities at quality check, and derives
 * `qualityStatus` itself — the field is not even in the request schema
 * (officer.md §4.3).
 *
 * `complete` prices the procurement in the same transaction. A blocked payment
 * is not an error: it is the system declining to invent a price for produce
 * nobody graded, and it says which of the two reasons applies.
 */
function WeighmentPage() {
  const { t, i18n } = useTranslation();

  const centre = useOfficerCentre();
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const [gross, setGross] = useState("");
  const [accepted, setAccepted] = useState("");
  const [rejected, setRejected] = useState("");
  const [grade, setGrade] = useState("");
  const [moisture, setMoisture] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");

  const bookings = useApiResource(
    (signal) =>
      api.centreBookings(
        centre.centreId,
        { date: todayInZone(centre.timezone), status: "ARRIVED,WEIGHING,QUALITY_CHECK,PROCUREMENT_RECORDED" },
        signal,
      ),
    [centre.centreId],
    { enabled: Boolean(centre.centreId) },
  );

  const rows = bookings.data ?? [];
  const active = rows.find((row) => row.bookingCode === selected) ?? rows[0] ?? null;
  const locale = i18n.language;
  const stage = active ? STAGE[active.status] : null;

  function resetForm() {
    setGross("");
    setAccepted("");
    setRejected("");
    setGrade("");
    setMoisture("");
    setRejectionReason("");
  }

  async function run(action) {
    if (!active) return;

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      if (action === "startWeighing") {
        await api.officerStartWeighing(active.bookingCode);
      }

      if (action === "recordWeight") {
        await api.officerRecordWeight(active.bookingCode, Number(gross));
      }

      if (action === "recordQuality") {
        // rejectionReason is required when rejected > 0 and refused when it is
        // zero, so it is sent only when it applies.
        const rejectedKg = Number(rejected || 0);

        await api.officerRecordQuality(active.bookingCode, {
          acceptedQuantityKg: Number(accepted),
          rejectedQuantityKg: rejectedKg,
          ...(grade.trim() ? { grade: grade.trim() } : {}),
          ...(moisture ? { moisturePercent: Number(moisture) } : {}),
          ...(rejectedKg > 0 ? { rejectionReason: rejectionReason.trim() } : {}),
        });
      }

      if (action === "complete") {
        const completed = await api.officerComplete(active.bookingCode);
        setResult(completed);
      }

      resetForm();
      bookings.reload();
    } catch (actionError) {
      setError(actionError);
    } finally {
      setBusy(false);
    }
  }

  const control =
    "w-full rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100";

  const payment = result?.payment ?? null;

  return (
    <OfficerLayout
      title={t("weighment")}
      subtitle={centre.centre?.name ?? t("procurementCentre")}
      stats={[
        { label: t("inProgress"), value: rows.length },
        {
          label: t("awaitingWeight"),
          value: rows.filter((row) => row.status === "WEIGHING").length,
        },
      ]}
      actions={<CentrePicker centre={centre} />}
    >
      {centre.error && <ErrorState error={centre.error} onRetry={centre.reload} />}

      {bookings.error && <ErrorState error={bookings.error} onRetry={bookings.reload} />}

      {(centre.loading || bookings.initialLoading) && <Loading />}

      {!bookings.initialLoading && rows.length === 0 && !bookings.error && (
        <EmptyState icon="⚖️" title={t("nothingToWeigh")} description={t("nothingToWeighNote")} />
      )}

      {rows.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="space-y-2">
            {rows.map((row) => (
              <button
                key={row.bookingCode}
                type="button"
                onClick={() => {
                  setSelected(row.bookingCode);
                  setError(null);
                  setResult(null);
                  resetForm();
                }}
                className={`w-full rounded-2xl border p-3 text-left transition ${
                  active?.bookingCode === row.bookingCode
                    ? "border-emerald-400 bg-emerald-50"
                    : "border-emerald-100 bg-white hover:bg-emerald-50/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xl font-black text-slate-900">{row.tokenNumber}</span>

                  <StatusBadge
                    status={row.status}
                    label={translateDisplayStatus(t, row.displayStatus)}
                  />
                </div>

                <p className="mt-1 text-xs text-slate-500">{row.crop?.name}</p>
              </button>
            ))}
          </div>

          {active && (
            <div className="rounded-[26px] border border-emerald-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-slate-500">{active.bookingCode}</p>

                  <h3 className="text-xl font-black text-slate-900">
                    {t("tokenNumberLabel")} {active.tokenNumber} · {active.crop?.name}
                  </h3>

                  <p className="mt-1 text-sm text-slate-500">
                    {t("declared")}: {formatQuantity(kgToQuintal(active.quantityKg), locale)}{" "}
                    {t("quintal")}
                  </p>
                </div>

                <StatusBadge
                  status={active.status}
                  label={translateDisplayStatus(t, active.displayStatus)}
                />
              </div>

              {error && <ErrorState error={error} className="mt-4" />}

              {/* --- step 1: start weighing ------------------------------ */}
              {stage === "startWeighing" && (
                <div className="mt-5">
                  <p className="text-sm text-slate-600">{t("startWeighingNote")}</p>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run("startWeighing")}
                    className="mt-4 rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                  >
                    {t("startWeighing")}
                  </button>
                </div>
              )}

              {/* --- step 2: gross weight -------------------------------- */}
              {stage === "recordWeight" && (
                <div className="mt-5 space-y-4">
                  <div>
                    <label htmlFor="gross" className="mb-1 block text-sm font-medium text-slate-700">
                      {t("grossQuantityKg")}
                    </label>

                    <input
                      id="gross"
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={gross}
                      onChange={(event) => setGross(event.target.value)}
                      className={control}
                    />

                    {/* The 2500-5000 range constrains what a farmer may REQUEST.
                        What arrives is a measurement, and 1200 kg is valid. */}
                    <p className="mt-1 text-xs text-slate-400">{t("grossWeightNote")}</p>
                  </div>

                  <button
                    type="button"
                    disabled={busy || !gross}
                    onClick={() => run("recordWeight")}
                    className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                  >
                    {t("recordWeight")}
                  </button>
                </div>
              )}

              {/* --- step 3: quality ------------------------------------- */}
              {stage === "recordQuality" && (
                <div className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="accepted" className="mb-1 block text-sm font-medium text-slate-700">
                        {t("acceptedQuantityKg")}
                      </label>

                      <input
                        id="accepted"
                        type="number"
                        step="0.001"
                        min="0"
                        value={accepted}
                        onChange={(event) => setAccepted(event.target.value)}
                        className={control}
                      />
                    </div>

                    <div>
                      <label htmlFor="rejected" className="mb-1 block text-sm font-medium text-slate-700">
                        {t("rejectedQuantityKg")}
                      </label>

                      <input
                        id="rejected"
                        type="number"
                        step="0.001"
                        min="0"
                        value={rejected}
                        onChange={(event) => setRejected(event.target.value)}
                        className={control}
                      />
                    </div>

                    <div>
                      <label htmlFor="grade" className="mb-1 block text-sm font-medium text-slate-700">
                        {t("grade")}
                      </label>

                      <input
                        id="grade"
                        type="text"
                        value={grade}
                        onChange={(event) => setGrade(event.target.value)}
                        className={control}
                      />

                      {/* The grade is the fourth part of an MSP rate's identity.
                          Without it a multi-rate crop cannot be priced. */}
                      <p className="mt-1 text-xs text-slate-400">{t("gradeDecidesPrice")}</p>
                    </div>

                    <div>
                      <label htmlFor="moisture" className="mb-1 block text-sm font-medium text-slate-700">
                        {t("moisture")} %
                      </label>

                      <input
                        id="moisture"
                        type="number"
                        step="0.1"
                        min="0"
                        value={moisture}
                        onChange={(event) => setMoisture(event.target.value)}
                        className={control}
                      />
                    </div>
                  </div>

                  {Number(rejected || 0) > 0 && (
                    <div>
                      <label
                        htmlFor="rejectionReason"
                        className="mb-1 block text-sm font-medium text-slate-700"
                      >
                        {t("rejectionReason")}
                      </label>

                      <input
                        id="rejectionReason"
                        type="text"
                        value={rejectionReason}
                        onChange={(event) => setRejectionReason(event.target.value)}
                        className={control}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={busy || accepted === ""}
                    onClick={() => run("recordQuality")}
                    className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                  >
                    {t("recordQuality")}
                  </button>
                </div>
              )}

              {/* --- step 4: complete and price -------------------------- */}
              {stage === "complete" && (
                <div className="mt-5">
                  <p className="text-sm text-slate-600">{t("completeNote")}</p>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run("complete")}
                    className="mt-4 rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-emerald-300"
                  >
                    {t("completeProcurement")}
                  </button>
                </div>
              )}

              {/* --- the priced result ----------------------------------- */}
              {payment && (
                <div
                  className={`mt-5 rounded-2xl border p-4 ${
                    payment.status === "BLOCKED"
                      ? "border-amber-200 bg-amber-50"
                      : "border-emerald-200 bg-emerald-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-slate-900">{t("payment")}</p>

                    <StatusBadge
                      status={payment.status}
                      label={translatePaymentStatus(t, payment.status)}
                    />
                  </div>

                  {payment.status === "BLOCKED" ? (
                    <p className="mt-2 text-sm text-amber-800">
                      {translatePaymentBlocked(t, payment.blockedReason)}
                    </p>
                  ) : (
                    <p className="mt-2 text-2xl font-black text-slate-900">
                      {formatRupees(payment.amountRupees, locale) ?? "—"}
                    </p>
                  )}

                  {result?.procurement && (
                    <p className="mt-2 text-xs text-slate-500">
                      {translateQualityStatus(t, result.procurement.qualityStatus)} ·{" "}
                      {formatQuantity(kgToQuintal(result.procurement.acceptedQuantityKg), locale)}{" "}
                      {t("quintal")}
                    </p>
                  )}
                </div>
              )}

              {!stage && !payment && (
                <p className="mt-5 text-sm text-slate-500">{t("noWeighmentActionAvailable")}</p>
              )}
            </div>
          )}
        </div>
      )}
    </OfficerLayout>
  );
}

export default WeighmentPage;

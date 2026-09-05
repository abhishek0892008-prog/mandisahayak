import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import api from "../lib/api";
import useApiResource from "../hooks/useApiResource";
import useOfficerCentre from "../hooks/useOfficerCentre";
import { formatTime, kgToQuintal, quintalToKg, todayInZone } from "../lib/format";

/**
 * The officer screens, backed by the server.
 *
 * The Mandi Sahayak screens were written against a local array of "farmers"
 * with flat fields — `status`, `actualWeight`, `paidAmount`. The API speaks
 * bookings, procurements and payments, in kilograms and paise, with a status
 * machine the database enforces (officer.md §3). This hook is the seam: it
 * reads the day, folds each booking's procurement and payment into the shape
 * the screens already render, and turns their callbacks into the transitions
 * the API allows from the booking's current state.
 *
 * Two rules it keeps:
 *
 *  - Nothing is invented. A field the server has not recorded reads empty
 *    rather than zero, so an unweighed booking never shows "0 quintal".
 *  - Nothing is stored across renders except what the officer is typing. Every
 *    figure comes from the last response, which is why a failed write leaves
 *    the screen showing what the server actually holds.
 */

/** API status → the word the prototype's screens print. */
const STATUS_LABEL = {
  CONFIRMED: "Queued",
  ARRIVED: "Arrived",
  WEIGHING: "Weighing",
  QUALITY_CHECK: "Quality check",
  PROCUREMENT_RECORDED: "Recorded",
  PAYMENT_PENDING: "Awaiting payment",
  COMPLETED: "Cleared",
  CANCELLED: "Cleared",
  NO_SHOW: "Cleared",
};

/** Statuses whose procurement and payment rows are worth fetching. */
const HAS_PROCUREMENT = [
  "ARRIVED",
  "WEIGHING",
  "QUALITY_CHECK",
  "PROCUREMENT_RECORDED",
  "PAYMENT_PENDING",
  "COMPLETED",
];

/** Kilograms as a quintal string the inputs can hold, or "" when unrecorded. */
function quintal(kg) {
  if (kg === null || kg === undefined) return "";
  const value = kgToQuintal(kg);
  return value === null ? "" : String(value);
}

export function useOfficerQueue() {
  const centre = useOfficerCentre();
  const [pickedDate, setPickedDate] = useState(null);
  const [details, setDetails] = useState({});
  const [drafts, setDrafts] = useState({});
  const [alert, setAlert] = useState(null);
  const [savedReportFarmerId, setSavedReportFarmerId] = useState(null);
  const [selectedReportFarmerId, setSelectedReportFarmerId] = useState(null);

  const selectedDate = pickedDate ?? todayInZone(centre.timezone);

  const bookings = useApiResource(
    (signal) =>
      api.centreBookings(centre.centreId, { date: selectedDate }, signal),
    [centre.centreId, selectedDate],
    { enabled: Boolean(centre.centreId), intervalMs: 10000 },
  );

  const rows = useMemo(() => bookings.data?.bookings ?? [], [bookings.data]);

  // The day list carries the booking only (officer.service.ts `listDay`), so
  // the procurement and payment behind each row are fetched per booking. Only
  // bookings that have actually arrived have either.
  const detailKey = rows
    .filter((row) => HAS_PROCUREMENT.includes(row.status))
    .map((row) => `${row.bookingCode}:${row.status}`)
    .join(",");

  const detailKeyRef = useRef(null);

  useEffect(() => {
    if (!detailKey) return undefined;
    if (detailKeyRef.current === detailKey) return undefined;
    detailKeyRef.current = detailKey;

    let cancelled = false;
    const codes = detailKey.split(",").map((entry) => entry.split(":")[0]);

    Promise.all(
      codes.map((code) =>
        api
          .officerBooking(code)
          .then((data) => [code, data])
          .catch(() => [code, null]),
      ),
    ).then((entries) => {
      if (cancelled) return;
      setDetails(Object.fromEntries(entries.filter(([, data]) => data)));
    });

    return () => {
      cancelled = true;
    };
  }, [detailKey]);

  const locale = "en";

  /** One booking, in the shape the screens were written against. */
  const farmers = useMemo(
    () =>
      rows.map((row) => {
        const detail = detailKey ? (details[row.bookingCode] ?? null) : null;
        const procurement = detail?.procurement ?? null;
        const payment = detail?.payment ?? null;
        const draft = drafts[row.bookingCode] ?? {};

        return {
          id: row.bookingCode,
          bookingCode: row.bookingCode,
          apiStatus: row.status,
          name: row.farmer?.name ?? "",
          phone: row.farmer?.phone ?? "",
          slot: formatTime(row.scheduledStartAt, centre.timezone, locale) ?? "",
          scheduledStartAt: row.scheduledStartAt ?? null,
          laneNo: row.laneNo ?? null,
          crop: row.crop?.name ?? "",
          quantity: quintal(row.requestedQuantityKg),
          landArea: row.farmer?.village ?? "",
          token: String(row.tokenNumber ?? row.bookingCode),
          status: STATUS_LABEL[row.status] ?? row.status,
          grossWeight: quintal(procurement?.grossQuantityKg),
          tareWeight: "",
          bagWeight: "",
          slipNumber: row.bookingCode,
          actualWeight: quintal(procurement?.acceptedQuantityKg),
          paidAmount: payment?.amountRupees ?? "",
          mspRate:
            payment?.ratePerQuintalPaise === null ||
            payment?.ratePerQuintalPaise === undefined
              ? ""
              : String(Number(payment.ratePerQuintalPaise) / 100),
          paymentBlockedReason: payment?.blockedReason ?? "",
          lateMinutes: "",
          paymentStatus: payment?.status === "PAID" ? "Cleared" : "Pending",
          reportSaved: row.status === "COMPLETED",
          rejectionReason: procurement?.rejectionReason ?? "",
          quality: {
            moisture:
              procurement?.moisturePercent === null ||
              procurement?.moisturePercent === undefined
                ? ""
                : String(procurement.moisturePercent),
            foreignMatter: procurement?.grade ?? "",
            brokenGrain: quintal(procurement?.rejectedQuantityKg),
          },
          date: row.serviceDate,
          ...draft,
        };
      }),
    [rows, details, detailKey, drafts, centre.timezone],
  );

  const queueStats = useMemo(() => {
    const active = farmers.filter((farmer) => farmer.status !== "Cleared");
    const arrived = farmers.filter((farmer) =>
      ["Arrived", "Weighing", "Quality check", "Recorded"].includes(
        farmer.status,
      ),
    );
    const cleared = farmers.filter((farmer) => farmer.status === "Cleared");

    return [
      { label: "In queue", value: active.length, tone: "bg-emerald-50" },
      { label: "At the centre", value: arrived.length, tone: "bg-lime-50" },
      { label: "Cleared", value: cleared.length, tone: "bg-emerald-50/60" },
    ];
  }, [farmers]);

  const flash = useCallback((message, tone = "success") => {
    setAlert({ message, tone });
    window.setTimeout(() => setAlert(null), 6000);
  }, []);

  /**
   * Runs one API call and refreshes the day.
   *
   * Errors surface as the same banner the prototype used for payment alerts,
   * carrying the server's error code — the codes are the contract, and an
   * officer who taps Verify twice should read `INVALID_STATE_TRANSITION`
   * rather than see nothing happen.
   */
  const run = useCallback(
    async (call, successMessage) => {
      try {
        const result = await call();
        detailKeyRef.current = null;
        bookings.reload();
        if (successMessage) flash(successMessage);
        return result;
      } catch (error) {
        flash(error?.code ?? "Request failed", "danger");
        return null;
      }
    },
    [bookings, flash],
  );

  const markFarmerArrived = useCallback(
    (bookingCode) => {
      const farmer = farmers.find((entry) => entry.id === bookingCode);
      return run(
        () => api.officerArrive(bookingCode),
        `Arrival recorded for ${farmer?.name ?? bookingCode}.`,
      );
    },
    [farmers, run],
  );

  /** "Verify" opens the weighbridge: ARRIVED → WEIGHING. */
  const verifyFarmer = useCallback(
    (bookingCode) =>
      run(
        () => api.officerStartWeighing(bookingCode),
        "Farmer sent to the weighbridge.",
      ),
    [run],
  );

  /** Screens type into their own copy; nothing is sent until they save. */
  const updateFarmer = useCallback((bookingCode, field, value) => {
    if (field === "status" || field === "paymentStatus") return;

    setDrafts((previous) => ({
      ...previous,
      [bookingCode]: { ...previous[bookingCode], [field]: value },
    }));
  }, []);

  const clearDraft = useCallback((bookingCode) => {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[bookingCode];
      return next;
    });
  }, []);

  /**
   * The weighment screen's save, mapped onto whichever transition the booking
   * is actually due. The screen shows one form; the lifecycle decides what the
   * form's contents mean right now.
   */
  const saveFarmerReport = useCallback(
    async (bookingCode, patch = {}) => {
      const farmer = farmers.find((entry) => entry.id === bookingCode);
      if (!farmer) return null;

      const gross = patch.grossWeight ?? farmer.grossWeight;
      const accepted = patch.actualWeight ?? farmer.actualWeight;
      const rejected = patch.rejectedWeight ?? farmer.quality?.brokenGrain;
      const grade = patch.grade ?? farmer.quality?.foreignMatter;
      const moisture = patch.moisture ?? farmer.quality?.moisture;
      const reason = patch.rejectionReason ?? farmer.rejectionReason;

      // A booking still at the gate is opened on the weighbridge first, so
      // one press of Save does what the officer means by it.
      if (farmer.apiStatus === "ARRIVED") {
        const opened = await run(
          () => api.officerStartWeighing(bookingCode),
          null,
        );
        if (!opened) return null;
      }

      if (farmer.apiStatus === "WEIGHING" || farmer.apiStatus === "ARRIVED") {
        const result = await run(
          () => api.officerRecordWeight(bookingCode, quintalToKg(gross)),
          "Gross weight recorded.",
        );
        if (result) clearDraft(bookingCode);
        return result;
      }

      if (farmer.apiStatus === "QUALITY_CHECK") {
        const rejectedKg = quintalToKg(rejected || 0) ?? 0;

        const result = await run(
          () =>
            api.officerRecordQuality(bookingCode, {
              acceptedQuantityKg: quintalToKg(accepted),
              rejectedQuantityKg: rejectedKg,
              ...(grade ? { grade: String(grade).trim() } : {}),
              ...(moisture ? { moisturePercent: Number(moisture) } : {}),
              ...(rejectedKg > 0
                ? { rejectionReason: String(reason || "").trim() }
                : {}),
            }),
          "Quality recorded.",
        );
        if (result) clearDraft(bookingCode);
        return result;
      }

      if (farmer.apiStatus === "PROCUREMENT_RECORDED") {
        const result = await run(
          () => api.officerComplete(bookingCode),
          "Procurement completed and priced.",
        );
        if (result) {
          clearDraft(bookingCode);
          setSelectedReportFarmerId(bookingCode);
        }
        return result;
      }

      flash("Nothing left to record for this booking.", "danger");
      return null;
    },
    [farmers, run, clearDraft, flash],
  );

  /** The queue's "Clear" finishes whatever step the booking is on. */
  const clearFarmer = useCallback(
    (bookingCode) => saveFarmerReport(bookingCode),
    [saveFarmerReport],
  );

  const handlePaymentStatusChange = useCallback(
    async (bookingCode, nextStatus) => {
      if (nextStatus !== "Cleared") return null;

      const result = await run(
        () => api.officerSetPaymentStatus(bookingCode, "PAID"),
        "Payment marked paid.",
      );

      if (result) {
        setSelectedReportFarmerId(bookingCode);
        setSavedReportFarmerId(bookingCode);
      }

      return result;
    },
    [run],
  );

  const handleDateChange = useCallback((nextDate) => {
    if (!nextDate) return;
    setPickedDate(nextDate);
    setSelectedReportFarmerId(null);
    setSavedReportFarmerId(null);
  }, []);

  const acknowledgeSavedReport = useCallback(
    () => setSavedReportFarmerId(null),
    [],
  );

  return {
    centre,
    farmers,
    selectedDateEntries: farmers,
    queueStats,
    paymentAlert: alert,
    selectedDate,
    selectedReportFarmerId,
    savedReportFarmerId,
    acknowledgeSavedReport,
    loading: centre.loading || bookings.initialLoading,
    error: centre.error ?? bookings.error,
    reload: bookings.reload,
    handleDateChange,
    handlePaymentStatusChange,
    updateFarmer,
    verifyFarmer,
    markFarmerArrived,
    saveFarmerReport,
    clearFarmer,
  };
}

export default useOfficerQueue;

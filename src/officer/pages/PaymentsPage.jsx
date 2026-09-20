import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

const paymentStatusButtons = ["Pending", "Processing", "Cleared"];

const PaymentsPage = ({
  farmers = [],
  onPaymentStatusChange,
  selectedDate,
}) => {
  const navigate = useNavigate();
  const [expandedId, setExpandedId] = useState(null);
  const [paymentReferences, setPaymentReferences] = useState({});
  const [referenceErrors, setReferenceErrors] = useState({});
  const [transitionErrors, setTransitionErrors] = useState({});

  // Only a booking the server has actually priced and moved to
  // "Awaiting payment" can be paid — anything earlier (Weighing, Quality
  // check, Recorded) has no payment row yet, so marking it "Cleared" here
  // fails with INVALID_STATE_TRANSITION on the server.
  const activePayments = useMemo(
    () =>
      farmers
        .filter((farmer) => farmer.apiStatus === "PAYMENT_PENDING")
        .sort(
          (a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            String(a.id).localeCompare(String(b.id)),
        ),
    [farmers],
  );

  const clearedPayments = useMemo(
    () =>
      farmers
        .filter(
          (farmer) =>
            farmer.paymentStatus === "Cleared" ||
            farmer.apiStatus === "COMPLETED",
        )
        .sort(
          (a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            String(a.id).localeCompare(String(b.id)),
        ),
    [farmers],
  );

  /**
   * The price is the server's, never this screen's.
   *
   * `complete` resolves the MSP rate by crop, season and marketing year and
   * prices the procurement in the same transaction (officer.md §5). Recomputing
   * it here from a rate table would produce a second, quietly different number
   * on the screen the officer pays from.
   */
  const getPriceBreakdown = (entry) => {
    const actualWeight = Number(entry.actualWeight || 0);
    const rate = Number(entry.mspRate || 0);
    const payable = Number(entry.paidAmount || 0);

    return {
      actualWeight,
      rate,
      payable,
    };
  };

  const handlePaymentStatusChange = async (id, status) => {
    const entry = farmers.find((farmer) => farmer.id === id);
    const currentStatus = entry?.paymentStatus ?? "Pending";

    if (status === "Cleared" && currentStatus !== "Processing") {
      setTransitionErrors((current) => ({
        ...current,
        [id]: "Move this payment to Processing before marking it cleared.",
      }));
      return;
    }

    const paymentReference = paymentReferences[id]?.trim() ?? "";

    if (status === "Cleared" && !paymentReference) {
      setReferenceErrors((current) => ({
        ...current,
        [id]: "Enter the transfer reference before clearing this payment.",
      }));
      return;
    }

    const result = await onPaymentStatusChange?.(id, status, paymentReference);

    setTransitionErrors((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

    if (result && status === "Cleared") {
      navigate("/officer/reports");
    }
  };

  return (
    <div className="rounded-3xl border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">
            Payments overview
          </h2>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {selectedDate ?? "Today"}
          </p>
        </div>
        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-800">
          {activePayments.length} settlement
          {activePayments.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-6 space-y-3">
        {activePayments.length === 0 ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-slate-700">
            No payment entries yet for this date.
          </div>
        ) : (
          activePayments.map((entry) => {
            const { actualWeight, rate, payable } = getPriceBreakdown(entry);
            const isExpanded = expandedId === entry.id;

            return (
              <div
                key={`${entry.date || selectedDate}-${entry.id}`}
                className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpandedId((current) =>
                      current === entry.id ? null : entry.id,
                    )
                  }
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white px-3 py-3 text-left"
                >
                  <div>
                    <p className="text-lg font-bold text-slate-900">
                      {entry.name}
                    </p>
                    <p className="text-sm text-slate-600">
                      {entry.date || selectedDate} • {entry.crop} • {entry.slot}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-slate-900">
                      ₹
                      {Number(entry.paidAmount || payable || 0).toLocaleString(
                        "en-IN",
                      )}
                    </span>
                    <span className="text-lg text-emerald-700">
                      {isExpanded ? "▴" : "▾"}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-4 rounded-2xl border border-emerald-200 bg-white p-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                          Actual weight
                        </p>
                        <p className="mt-1 font-bold text-slate-900">
                          {actualWeight} quintal
                        </p>
                      </div>
                      <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                          MSP rate
                        </p>
                        <p className="mt-1 font-bold text-slate-900">
                          ₹{rate.toLocaleString("en-IN")}
                        </p>
                      </div>
                      <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                          Payable amount
                        </p>
                        <p className="mt-1 font-bold text-slate-900">
                          ₹{payable.toLocaleString("en-IN")}
                        </p>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                      {paymentStatusButtons.map((status) => {
                        const isActive =
                          (entry.paymentStatus ?? "Pending") === status;

                        return (
                          <button
                            key={status}
                            type="button"
                            onClick={() =>
                              handlePaymentStatusChange(entry.id, status)
                            }
                            className={[
                              "min-w-27.5 rounded-full border px-5 py-2.5 text-sm font-semibold transition",
                              isActive
                                ? "border-green-700 bg-green-700 text-white"
                                : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
                            ].join(" ")}
                          >
                            {status === "Cleared" ? "✅" : "⏳"} {status}
                          </button>
                        );
                      })}
                    </div>

                    <div className="mt-4">
                      <label
                        htmlFor={`payment-reference-${entry.id}`}
                        className="block text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700"
                      >
                        Payment reference / cash receipt number
                      </label>
                      <input
                        id={`payment-reference-${entry.id}`}
                        type="text"
                        value={paymentReferences[entry.id] ?? ""}
                        onChange={(event) =>
                          (() => {
                            setPaymentReferences((current) => ({
                              ...current,
                              [entry.id]: event.target.value,
                            }));
                            setReferenceErrors((current) => {
                              if (!current[entry.id]) return current;
                              const next = { ...current };
                              delete next[entry.id];
                              return next;
                            });
                          })()
                        }
                        placeholder="Enter UTR or cash receipt number"
                        className="mt-2 min-h-11 w-full rounded-xl border border-emerald-200 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-600 focus:ring-4 focus:ring-emerald-50"
                      />
                      <p
                        className={`mt-1 text-xs ${referenceErrors[entry.id] ? "font-semibold text-red-600" : "text-slate-500"}`}
                      >
                        {referenceErrors[entry.id] ??
                          "Required before marking this payment cleared."}
                      </p>
                      {transitionErrors[entry.id] && (
                        <p className="mt-1 text-xs font-semibold text-red-600">
                          {transitionErrors[entry.id]}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {clearedPayments.length > 0 && (
        <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
          <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-emerald-800">
            Cleared payments
          </h3>
          <div className="mt-3 space-y-2">
            {clearedPayments.map((entry) => (
              <div
                key={`cleared-${entry.date || selectedDate}-${entry.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-white px-3 py-2"
              >
                <div>
                  <p className="font-bold text-slate-900">{entry.name}</p>
                  <p className="text-xs text-slate-600">
                    {entry.crop} • ₹
                    {Number(entry.paidAmount || 0).toLocaleString("en-IN")}
                  </p>
                </div>
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-800">
                  Cleared
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default PaymentsPage;

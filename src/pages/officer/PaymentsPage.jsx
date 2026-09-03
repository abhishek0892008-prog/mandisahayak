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

  const activePayments = useMemo(
    () =>
      farmers
        .filter(
          (farmer) =>
            (farmer.paidAmount ||
              farmer.paymentStatus ||
              farmer.status === "Cleared") &&
            farmer.paymentStatus !== "Cleared" &&
            farmer.status !== "Cleared",
        )
        .sort(
          (a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            Number(a.id) - Number(b.id),
        ),
    [farmers],
  );

  const clearedPayments = useMemo(
    () =>
      farmers
        .filter(
          (farmer) =>
            farmer.paymentStatus === "Cleared" || farmer.status === "Cleared",
        )
        .sort(
          (a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            Number(a.id) - Number(b.id),
        ),
    [farmers],
  );

  const getPriceBreakdown = (entry) => {
    const cropRateMap = {
      Wheat: 2275,
      Rice: 2225,
      Mustard: 5650,
      Gram: 5230,
    };

    const actualWeight = Number(entry.actualWeight || entry.quantity || 0);
    const rate = Number(entry.mspRate ?? cropRateMap[entry.crop] ?? 0);
    const payable = actualWeight * rate;

    return {
      actualWeight,
      rate,
      payable,
    };
  };

  const handlePaymentStatusChange = (id, status) => {
    onPaymentStatusChange?.(id, status);

    if (status === "Cleared") {
      navigate("/reports");
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
                          {actualWeight} kg
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
                            {status}
                          </button>
                        );
                      })}
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

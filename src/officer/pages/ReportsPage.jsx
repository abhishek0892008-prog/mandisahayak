import { useMemo, useState } from "react";

const ReportsPage = ({
  farmers = [],
  selectedDate,
  selectedFarmerId = null,
  savedFarmerId = null,
  onAcknowledgeSavedReport,
}) => {
  const clearedFarmers = useMemo(
    () =>
      farmers
        .filter(
          (farmer) =>
            farmer.status === "Cleared" || farmer.paymentStatus === "Cleared",
        )
        .sort(
          (a, b) =>
            (a.date || "").localeCompare(b.date || "") ||
            Number(b.id) - Number(a.id),
        ),
    [farmers],
  );

  const [activeFarmerId, setActiveFarmerId] = useState(selectedFarmerId);
  const [syncedFarmerId, setSyncedFarmerId] = useState(selectedFarmerId);

  // A save picks the record to show; clicking the cleared list overrides it.
  if (selectedFarmerId !== syncedFarmerId) {
    setSyncedFarmerId(selectedFarmerId);
    setActiveFarmerId(selectedFarmerId);
  }

  const selectedFarmer = useMemo(() => {
    if (!clearedFarmers.length) return null;
    const chosenId = activeFarmerId ?? selectedFarmerId ?? clearedFarmers[0].id;
    return (
      clearedFarmers.find((farmer) => farmer.id === chosenId) ??
      clearedFarmers[0]
    );
  }, [activeFarmerId, clearedFarmers, selectedFarmerId]);

  const [form, setForm] = useState({
    name: "",
    token: "",
    crop: "",
    quantity: "",
    slot: "",
    actualWeight: "",
    money: "",
    paymentStatus: "Pending",
  });

  const [formFarmer, setFormFarmer] = useState(null);

  if (selectedFarmer && selectedFarmer !== formFarmer) {
    setFormFarmer(selectedFarmer);
    setForm({
      name: selectedFarmer.name ?? "",
      token: selectedFarmer.token ?? "",
      crop: selectedFarmer.crop ?? "",
      quantity: selectedFarmer.quantity ?? "",
      slot: selectedFarmer.slot ?? "",
      actualWeight: selectedFarmer.actualWeight ?? "",
      money: selectedFarmer.paidAmount ?? "",
      paymentStatus: selectedFarmer.paymentStatus ?? "Pending",
    });
  }

  // The summary is derived, not stored: it shows for the one booking a save
  // just signalled, and disappears the moment that signal is acknowledged.
  const savedSummary = useMemo(() => {
    if (savedFarmerId == null) return null;

    const savedFarmer = clearedFarmers.find(
      (farmer) => farmer.id === savedFarmerId,
    );
    if (!savedFarmer) return null;

    return {
      name: savedFarmer.name,
      token: savedFarmer.token,
      crop: savedFarmer.crop,
      actualWeight: savedFarmer.actualWeight || savedFarmer.quantity || "0",
      money: savedFarmer.paidAmount || "0",
      paymentStatus: savedFarmer.paymentStatus || "Cleared",
    };
  }, [clearedFarmers, savedFarmerId]);

  const cropTotals = useMemo(() => {
    const summary = {};

    clearedFarmers.forEach((farmer) => {
      const cropName = farmer.crop || "Other";
      const quantity = Number(farmer.actualWeight || farmer.quantity || 0);
      const amount = Number(farmer.paidAmount || 0);

      if (!summary[cropName]) {
        summary[cropName] = {
          crop: cropName,
          totalQuantity: 0,
          totalAmount: 0,
          farmers: 0,
        };
      }

      summary[cropName].totalQuantity += quantity;
      summary[cropName].totalAmount += amount;
      summary[cropName].farmers += 1;
    });

    return Object.values(summary).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [clearedFarmers]);

  const totalQuantity = cropTotals.reduce(
    (sum, crop) => sum + Number(crop.totalQuantity || 0),
    0,
  );
  const totalAmount = cropTotals.reduce(
    (sum, crop) => sum + Number(crop.totalAmount || 0),
    0,
  );

  const reports = [
    {
      title: "Daily collection",
      value: `${clearedFarmers.length || 0} slots cleared`,
      detail: "Today’s cleared queue",
    },
    {
      title: "Farmers served",
      value: String(clearedFarmers.length || 0),
      detail: "Across active procurement",
    },
    {
      title: "Net due",
      value: `₹${totalAmount.toLocaleString("en-IN")}`,
      detail: "Payments entered today",
    },
  ];

  return (
    <>
      {savedSummary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4">
          <div className="w-full max-w-md rounded-[28px] border border-emerald-200 bg-white p-6 shadow-[0_20px_60px_rgba(15,23,42,0.2)]">
            <div className="flex items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
                ✓
              </div>
            </div>

            <h3 className="mt-4 text-center text-2xl font-black text-slate-900">
              Report saved
            </h3>

            <div className="mt-4 space-y-2 rounded-2xl border border-emerald-100 bg-emerald-50 p-4 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Farmer</span>
                <span className="text-right font-bold text-slate-900">
                  {savedSummary.name}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Token</span>
                <span className="text-right font-bold text-slate-900">
                  {savedSummary.token}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Crop</span>
                <span className="text-right font-bold text-slate-900">
                  {savedSummary.crop}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Actual weight</span>
                <span className="text-right font-bold text-slate-900">
                  {savedSummary.actualWeight} quintal
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Amount</span>
                <span className="text-right font-bold text-slate-900">
                  ₹{Number(savedSummary.money || 0).toLocaleString("en-IN")}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Status</span>
                <span className="text-right font-bold text-emerald-700">
                  {savedSummary.paymentStatus}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onAcknowledgeSavedReport?.()}
              className="mt-4 w-full rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
            >
              ✅ OK
            </button>
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-3xl border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Cleared slot
            </p>
            <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">
              Operational reports
            </h2>
            <p className="mt-1 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {selectedDate ?? "Today"}
            </p>
          </div>
          <button className="rounded-full border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100">
            📄 Export PDF
          </button>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {reports.map((report) => (
            <div
              key={report.title}
              className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"
            >
              <p className="text-sm font-medium text-emerald-800">
                {report.title}
              </p>
              <h3 className="mt-2 text-3xl font-black text-slate-900">
                {report.value}
              </h3>
              <p className="mt-2 text-sm text-slate-600">{report.detail}</p>
            </div>
          ))}
        </div>

        <div className="rounded-[26px] border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-xl font-black text-slate-900">
              Today’s report
            </h3>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
              {totalQuantity} quintal total
            </span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-emerald-200">
            <table className="min-w-full divide-y divide-emerald-200 text-left text-sm">
              <thead className="bg-emerald-50 text-emerald-900">
                <tr>
                  <th className="px-3 py-2 font-bold">Crop</th>
                  <th className="px-3 py-2 font-bold">Farmers</th>
                  <th className="px-3 py-2 font-bold">Qty bought</th>
                  <th className="px-3 py-2 font-bold">Amount paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100 bg-white">
                {cropTotals.length === 0 ? (
                  <tr>
                    <td colSpan="4" className="px-3 py-4 text-slate-600">
                      No cleared records yet.
                    </td>
                  </tr>
                ) : (
                  cropTotals.map((crop) => (
                    <tr key={crop.crop}>
                      <td className="px-3 py-2 font-semibold text-slate-800">
                        {crop.crop}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {crop.farmers}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {Number(crop.totalQuantity || 0).toLocaleString(
                          "en-IN",
                        )}{" "}
                        quintal
                      </td>
                      <td className="px-3 py-2 font-semibold text-slate-900">
                        ₹{Number(crop.totalAmount || 0).toLocaleString("en-IN")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {clearedFarmers.length > 0 && (
          <div className="rounded-[22px] border border-emerald-200 bg-emerald-50 p-4 shadow-sm shadow-emerald-200/30">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Cleared records
            </p>
            <div className="flex flex-wrap gap-2">
              {clearedFarmers.map((farmer) => {
                const isSelected = selectedFarmer?.id === farmer.id;

                return (
                  <button
                    key={farmer.id}
                    type="button"
                    onClick={() => setActiveFarmerId(farmer.id)}
                    className={[
                      "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                      isSelected
                        ? "border-green-700 bg-green-700 text-white"
                        : "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
                    ].join(" ")}
                  >
                    {farmer.token} • {farmer.slot}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selectedFarmer ? (
          <div className="rounded-[26px] border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                  Active entry
                </p>
                <h3 className="text-xl font-black text-slate-900">
                  {selectedFarmer.token}
                </h3>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Farmer name
                <input
                  value={form.name}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Token
                <input
                  value={form.token}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Crop
                <input
                  value={form.crop}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Qty (quintal)
                <input
                  value={form.quantity}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Slot time
                <input
                  value={form.slot}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Date
                <input
                  value={selectedFarmer.date ?? selectedDate ?? ""}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Actual weight (quintal)
                <input
                  value={form.actualWeight}
                  readOnly
                  className="mt-1 w-full cursor-default rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Money (₹)
                <input
                  value={form.money}
                  readOnly
                  className="mt-1 w-full cursor-default rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>

              <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
                Payment status
                <input
                  value={form.paymentStatus}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
                />
              </label>
            </div>

          </div>
        ) : (
          <div className="rounded-[26px] border border-emerald-200 bg-emerald-50 p-5 text-slate-700">
            No cleared slots yet for today.
          </div>
        )}
      </div>
    </>
  );
};

export default ReportsPage;

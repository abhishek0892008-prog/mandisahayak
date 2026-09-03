import { useEffect, useMemo, useState } from "react";

const WeighmentPage = ({ farmers = [], onUpdateFarmer, onSaveReport }) => {
  const [selectedFarmerId, setSelectedFarmerId] = useState(null);

  const activeFarmers = useMemo(
    () =>
      farmers.filter(
        (farmer) =>
          ["Arrived", "Weighing"].includes(farmer.status) &&
          !farmer.reportSaved,
      ),
    [farmers],
  );

  const savedFarmers = useMemo(
    () =>
      farmers.filter(
        (farmer) => farmer.reportSaved || farmer.status === "Cleared",
      ),
    [farmers],
  );

  const selectedFarmer = useMemo(() => {
    if (!activeFarmers.length) return null;
    return (
      activeFarmers.find((farmer) => farmer.id === selectedFarmerId) ??
      activeFarmers[0]
    );
  }, [activeFarmers, selectedFarmerId]);

  useEffect(() => {
    if (selectedFarmer?.status === "Arrived") {
      onUpdateFarmer?.(selectedFarmer.id, "status", "Weighing");
    }
  }, [onUpdateFarmer, selectedFarmer]);

  const gross = Number(selectedFarmer?.grossWeight ?? 0);
  const tare = Number(selectedFarmer?.tareWeight ?? 0);
  const bagWeight = Number(selectedFarmer?.bagWeight ?? 0);
  const netWeight = Number.isFinite(gross - tare - bagWeight)
    ? gross - tare - bagWeight
    : 0;

  const declared = Number(selectedFarmer?.quantity ?? 0);
  const variance = declared > 0 ? netWeight - declared : 0;
  const isAlert = Math.abs(variance) > 50;

  const updateField = (field, value) => {
    if (!selectedFarmer) return;
    onUpdateFarmer?.(selectedFarmer.id, field, value);
  };

  const handleSave = () => {
    if (!selectedFarmer) return;

    onSaveReport?.(selectedFarmer.id, {
      actualWeight: String(netWeight || 0),
      lateMinutes: selectedFarmer.lateMinutes ?? "",
      paymentStatus: "Pending",
    });

    setSelectedFarmerId(null);
  };

  if (!selectedFarmer) {
    return (
      <div className="space-y-4">
        <div className="rounded-[26px] border border-emerald-200 bg-emerald-50 p-6 text-slate-700">
          No farmer records available for weighment.
        </div>

        {savedFarmers.length > 0 && (
          <div className="rounded-[26px] border border-emerald-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900">
              Saved weighment records
            </h3>
            <div className="mt-4 space-y-2">
              {savedFarmers.map((farmer) => (
                <div
                  key={`saved-weighment-${farmer.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2"
                >
                  <div>
                    <p className="font-bold text-slate-900">{farmer.name}</p>
                    <p className="text-xs text-slate-600">
                      {farmer.crop} •{" "}
                      {farmer.actualWeight || farmer.quantity || 0} kg
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-800">
                    Saved
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-28">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            Weighment
          </p>
          <h2 className="text-2xl font-black text-slate-900 sm:text-3xl">
            Official procurement measurement
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeFarmers.map((farmer) => (
            <button
              key={farmer.id}
              type="button"
              onClick={() => setSelectedFarmerId(farmer.id)}
              className={[
                "rounded-full border px-3 py-1.5 text-xs font-semibold",
                selectedFarmer.id === farmer.id
                  ? "border-green-700 bg-green-700 text-white"
                  : "border-emerald-200 bg-emerald-50 text-emerald-900",
              ].join(" ")}
            >
              {farmer.token || farmer.name}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Active farmer
            </p>
            <h3 className="mt-2 text-2xl font-black text-slate-900">
              {selectedFarmer.name}
            </h3>
          </div>
          <span className="rounded-full bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
            {selectedFarmer.token}
          </span>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
            Gross weight (kg)
            <input
              type="number"
              value={selectedFarmer.grossWeight ?? ""}
              onChange={(event) =>
                updateField("grossWeight", event.target.value)
              }
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none"
            />
          </label>

          <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
            Tare weight (kg)
            <input
              type="number"
              value={selectedFarmer.tareWeight ?? ""}
              onChange={(event) =>
                updateField("tareWeight", event.target.value)
              }
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none"
            />
          </label>

          <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
            Bag weight (kg)
            <input
              type="number"
              value={selectedFarmer.bagWeight ?? ""}
              onChange={(event) => updateField("bagWeight", event.target.value)}
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none"
            />
          </label>

          <label className="space-y-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-700 md:col-span-2 xl:col-span-1">
            Weighbridge slip no.
            <input
              value={selectedFarmer.slipNumber ?? ""}
              onChange={(event) =>
                updateField("slipNumber", event.target.value)
              }
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none"
            />
          </label>
        </div>

        <div className="mt-6 rounded-3xl border border-emerald-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                Official net weight
              </p>
              <p className="mt-1 text-4xl font-black text-slate-900">
                {netWeight.toFixed(1)} kg
              </p>
            </div>
            <div className="text-sm font-semibold text-slate-600">
              Declared: {declared} kg
            </div>
          </div>

          {isAlert && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
              Alert: actual net weight differs from declared quantity by{" "}
              {Math.abs(variance).toFixed(1)} kg.
            </div>
          )}
        </div>
      </div>

      <div className="fixed bottom-6 right-6 z-30">
        <button
          type="button"
          onClick={handleSave}
          className="rounded-full bg-green-700 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-200 hover:bg-green-800"
        >
          Save weighment report
        </button>
      </div>

      {savedFarmers.length > 0 && (
        <div className="rounded-[26px] border border-emerald-200 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-bold text-slate-900">
            Saved weighment records
          </h3>
          <div className="mt-4 space-y-2">
            {savedFarmers.map((farmer) => (
              <div
                key={`saved-weighment-${farmer.id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2"
              >
                <div>
                  <p className="font-bold text-slate-900">{farmer.name}</p>
                  <p className="text-xs text-slate-600">
                    {farmer.crop} •{" "}
                    {farmer.actualWeight || farmer.quantity || 0} kg
                  </p>
                </div>
                <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-800">
                  Saved
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default WeighmentPage;

import { useMemo, useState } from "react";

const defaultCropChoices = ["Wheat", "Rice", "Mustard", "Gram"];


const DashboardPage = ({
  farmers = [],
  morningSetup,
  onSaveMorningSetup,
  storage = [],
}) => {
  const [form, setForm] = useState({
    weighbridgeWorking: true,
    slotsOpen: 6,
    shiftStart: "08:00",
    shiftEnd: "18:00",
    acceptedCrops: ["Wheat", "Rice", "Mustard"],
    mspRates: {
      Wheat: 2275,
      Rice: 2225,
      Mustard: 5650,
      Gram: 5230,
    },
  });
  const [dashboardSearch, setDashboardSearch] = useState("");
  const [dashboardFarmer, setDashboardFarmer] = useState(null);

  // Re-seed the form when a different setup arrives. Done during render
  // rather than in an effect so the fields never paint one frame stale.
  const [syncedSetup, setSyncedSetup] = useState(morningSetup);

  if (morningSetup && morningSetup !== syncedSetup) {
    setSyncedSetup(morningSetup);
    setForm({
      weighbridgeWorking: Boolean(morningSetup.weighbridgeWorking),
      slotsOpen: Number(morningSetup.slotsOpen ?? 6),
      shiftStart: morningSetup.shiftStart ?? "08:00",
      shiftEnd: morningSetup.shiftEnd ?? "18:00",
      acceptedCrops: Array.isArray(morningSetup.acceptedCrops)
        ? morningSetup.acceptedCrops
        : ["Wheat", "Rice", "Mustard"],
      mspRates: {
        ...defaultCropChoices.reduce((acc, crop) => {
          acc[crop] = Number(morningSetup.mspRates?.[crop] ?? 0);
          return acc;
        }, {}),
      },
    });
  }


  const matchingDashboardFarmer = useMemo(() => {
    const query = dashboardSearch.trim();
    if (!query) return null;

    const normalizeValue = (value = "") =>
      String(value)
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();

    const normalizedQuery = normalizeValue(query);
    if (!normalizedQuery) return null;

    // Exact matches first, so a short token like "2" never gets shadowed by
    // some other farmer's phone number happening to contain a "2".
    const exactMatch = farmers.find((entry) => {
      const tokenValue = normalizeValue(entry.token);
      const phoneValue = normalizeValue(entry.phone);
      return tokenValue === normalizedQuery || phoneValue === normalizedQuery;
    });
    if (exactMatch) return exactMatch;

    // Partial matching only kicks in once the query is specific enough
    // (4+ digits/letters) to avoid matching against almost every phone number.
    if (normalizedQuery.length < 4) return null;

    return (
      farmers.find((entry) => {
        const tokenValue = normalizeValue(entry.token);
        const phoneValue = normalizeValue(entry.phone);
        return (
          tokenValue.includes(normalizedQuery) ||
          phoneValue.includes(normalizedQuery)
        );
      }) ?? null
    );
  }, [dashboardSearch, farmers]);

  const handleDashboardSearch = () => {
    setDashboardFarmer(matchingDashboardFarmer ?? null);
  };

  const activeFarmers = useMemo(
    () => farmers.filter((farmer) => farmer.status !== "Cleared"),
    [farmers],
  );

  const availableSlots = Math.max(
    (form.slotsOpen ?? 0) - activeFarmers.length,
    0,
  );

  const dashboardStorage = useMemo(() => {
    const purchasedByCrop = farmers.reduce((totals, farmer) => {
      if (!farmer.reportSaved && farmer.status !== "Cleared") return totals;

      const crop = farmer.crop || "Other";
      totals[crop] = (totals[crop] || 0) +
        Number(farmer.actualWeight || farmer.quantity || 0);
      return totals;
    }, {});

    return storage.map((crop) => ({
      ...crop,
      stock: Number(crop.stock || 0) + (purchasedByCrop[crop.crop] || 0),
    }));
  }, [farmers, storage]);

  const summary = [
    {
      label: "Weighbridge",
      value: form.weighbridgeWorking ? "Operational" : "Closed",
      tone: form.weighbridgeWorking
        ? "bg-emerald-100 text-emerald-900"
        : "bg-red-100 text-red-700",
    },
    {
      label: "Total slots today",
      value: `${form.slotsOpen} slots`,
      tone: "bg-emerald-50 text-emerald-900",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            Dashboard
          </p>
          <h2 className="text-2xl font-black text-slate-900 sm:text-3xl">
            Procurement center overview
          </h2>
        </div>
        <button
          type="button"
          onClick={() =>
            onSaveMorningSetup?.({
              ...form,
              acceptedCrops: form.acceptedCrops,
              shiftStart: form.shiftStart,
              shiftEnd: form.shiftEnd,
            })
          }
          className="rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
        >
          🔄 Refresh dashboard
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-2">
        {summary.map((item) => (
          <div
            key={item.label}
            className={`rounded-2xl border border-emerald-200 p-4 ${item.tone}`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em]">
              {item.label}
            </p>
            {item.label === "Weighbridge" ? (
              <select
                value={form.weighbridgeWorking ? "working" : "closed"}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    weighbridgeWorking: event.target.value === "working",
                  }))
                }
                className="mt-2 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2 text-lg font-black text-slate-900 outline-none"
              >
                <option value="working">Operational</option>
                <option value="closed">Closed</option>
              </select>
            ) : (
              <p className="mt-2 text-2xl font-black">{item.value}</p>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Today’s shift
            </p>
            <h3 className="mt-2 text-lg font-bold text-slate-900">
              Shift timing
            </h3>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold text-slate-700">
            Shift start
            <input
              type="time"
              value={form.shiftStart}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  shiftStart: event.target.value,
                }))
              }
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none"
            />
          </label>

          <label className="space-y-2 text-sm font-semibold text-slate-700">
            Shift end
            <input
              type="time"
              value={form.shiftEnd}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  shiftEnd: event.target.value,
                }))
              }
              className="mt-1 w-full rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-900 outline-none"
            />
          </label>
        </div>
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Slot availability
            </p>
            <h3 className="mt-2 text-lg font-bold text-slate-900">
              Live capacity overview
            </h3>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-emerald-200 bg-white p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Available
            </p>
            <p className="mt-2 text-3xl font-black text-slate-900">
              {availableSlots}
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-200 bg-white p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Booked
            </p>
            <p className="mt-2 text-3xl font-black text-slate-900">
              {activeFarmers.length}
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-200 bg-white p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Total capacity
            </p>
            <p className="mt-2 text-3xl font-black text-slate-900">
              {form.slotsOpen}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Farmer lookup
            </p>
            <h3 className="mt-2 text-lg font-bold text-slate-900">
              Quick search
            </h3>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <input
            value={dashboardSearch}
            onChange={(event) => setDashboardSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleDashboardSearch();
            }}
            placeholder="Enter token number or phone"
            className="flex-1 rounded-xl border border-emerald-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none"
          />
          <button
            type="button"
            onClick={handleDashboardSearch}
            className="rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
          >
            🔍 Search
          </button>
        </div>

        {dashboardFarmer ? (
          <div className="mt-4 rounded-2xl border border-emerald-200 bg-white p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Farmer found
                </p>
                <p className="mt-1 text-lg font-black text-slate-900">
                  {dashboardFarmer.name}
                </p>
              </div>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
                {dashboardFarmer.token}
              </span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Crop
                </p>
                <p className="mt-1 font-bold text-slate-900">
                  {dashboardFarmer.crop}
                </p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Status
                </p>
                <p className="mt-1 font-bold text-slate-900">
                  {dashboardFarmer.status}
                </p>
              </div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Phone
                </p>
                <p className="mt-1 font-bold text-slate-900">
                  {dashboardFarmer.phone || "N/A"}
                </p>
              </div>
            </div>
          </div>
        ) : dashboardSearch ? (
          <div className="mt-4 rounded-2xl border border-dashed border-emerald-200 bg-white p-4 text-sm text-slate-700">
            No farmer found for this token or phone number.
          </div>
        ) : null}
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-white p-5 shadow-sm shadow-emerald-200/30">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Storage overview
            </p>
            <h3 className="mt-2 text-lg font-bold text-slate-900">
              Crop-wise storage summary
            </h3>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-emerald-200">
          <table className="min-w-full divide-y divide-emerald-200 text-left text-sm">
            <thead className="bg-emerald-50 text-emerald-900">
              <tr>
                <th className="px-3 py-2 font-bold">Crop</th>
                <th className="px-3 py-2 font-bold">MSP</th>
                <th className="px-3 py-2 font-bold">Total capacity</th>
                <th className="px-3 py-2 font-bold">Available space</th>
                <th className="px-3 py-2 font-bold">Filled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-emerald-100 bg-white">
              {dashboardStorage.map((crop) => {
                const capacity = Number(crop.capacity || 0);
                const available = Math.max(
                  capacity - Number(crop.stock || 0),
                  0,
                );
                const filledPercent =
                  capacity > 0
                    ? Math.min(100, ((capacity - available) / capacity) * 100)
                    : 0;
                const msp = Number(form.mspRates?.[crop.crop] ?? 0);

                return (
                  <tr key={crop.crop}>
                    <td className="px-3 py-2 font-semibold text-slate-800">
                      {crop.crop}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      ₹{msp.toLocaleString("en-IN")}
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {capacity.toLocaleString("en-IN")} quintal
                    </td>
                    <td className="px-3 py-2 font-semibold text-slate-900">
                      {available.toLocaleString("en-IN")} quintal
                    </td>
                    <td className="px-3 py-2 font-semibold text-emerald-800">
                      {filledPercent.toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};

export default DashboardPage;

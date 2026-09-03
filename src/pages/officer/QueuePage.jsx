import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Slot } from "../components/Slot";

const QueuePage = ({
  farmers,
  selectedDate,
  morningSetup,
  slotOptions = [],
  onDateChange,
  onAddFarmer,
  onUpdateFarmer,
  onClearFarmer,
}) => {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const [selectedCrop, setSelectedCrop] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("Active");

  const visibleFarmers = useMemo(
    () =>
      farmers.filter((farmer) =>
        selectedStatus === "Active"
          ? farmer.status !== "Cleared"
          : farmer.status === "Cleared",
      ),
    [farmers, selectedStatus],
  );

  const cropFilters = [
    "All",
    ...new Set(visibleFarmers.map((farmer) => farmer.crop)),
  ];

  const filteredFarmers = useMemo(() => {
    if (selectedCrop === "All") return visibleFarmers;
    return visibleFarmers.filter((farmer) => farmer.crop === selectedCrop);
  }, [selectedCrop, visibleFarmers]);

  const handleClearFarmer = (id) => {
    const clearedFarmer = onClearFarmer(id);
    if (clearedFarmer) {
      navigate("/reports");
    }
  };

  const headerTitle =
    selectedStatus === "Active" ? "Queue list" : "Cleared today";

  return (
    <div className="space-y-5">
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            Live queue
          </p>
          <h2 className="text-2xl font-black leading-tight text-slate-900 sm:text-3xl">
            Today's procurement
          </h2>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-slate-900">
          <span className="text-xs uppercase tracking-[0.14em] text-emerald-700">
            Date
          </span>
          <input
            type="date"
            min={today}
            value={selectedDate}
            onChange={(event) => onDateChange?.(event.target.value)}
            className="bg-transparent text-sm font-semibold text-slate-900 outline-none"
          />
        </label>
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/60 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold text-slate-900">Queue overview</h3>
          <span className="rounded-full bg-green-700 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white">
            {morningSetup?.slotsOpen ?? 0} total slots today
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { label: "Active", value: "Active" },
          { label: "Cleared today", value: "Cleared" },
        ].map((tab) => {
          const active = selectedStatus === tab.value;

          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setSelectedStatus(tab.value)}
              className={[
                "rounded-full border px-3 py-1.5 text-sm font-semibold transition",
                active
                  ? "border-green-700 bg-green-700 text-white"
                  : "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
              ].join(" ")}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        {cropFilters.map((crop) => {
          const active = crop === selectedCrop;

          return (
            <button
              key={crop}
              type="button"
              onClick={() => setSelectedCrop(crop)}
              className={[
                "rounded-full border px-3 py-1.5 text-sm font-semibold transition",
                active
                  ? "border-green-700 bg-green-700 text-white"
                  : "border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100",
              ].join(" ")}
            >
              {crop}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-700">
            Farmers
          </p>
          <p className="mt-2 text-3xl font-black text-slate-900">
            {filteredFarmers.length}
          </p>
        </div>

        <div className="rounded-2xl border border-lime-200 bg-lime-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-lime-800">
            Next slot
          </p>
          <p className="mt-2 text-3xl font-black text-slate-900">
            {filteredFarmers[0]?.slot ?? "N/A"}
          </p>
        </div>
      </div>

      <div className="rounded-[26px] border border-emerald-200 bg-white p-4 shadow-sm shadow-emerald-200/30">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xl font-bold text-slate-900">{headerTitle}</h3>
        </div>

        {filteredFarmers.length === 0 ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-slate-700">
            {selectedStatus === "Active"
              ? "No active slots for this date. Book a farmer to add the next queue entry."
              : "No cleared slots for this date yet."}
          </div>
        ) : (
          filteredFarmers.map((farmer, index) => (
            <Slot
              key={farmer.id}
              farmer={farmer}
              isHighlighted={index === 0 && selectedStatus === "Active"}
              onUpdateFarmer={onUpdateFarmer}
              onClearFarmer={handleClearFarmer}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default QueuePage;

import { useMemo, useState } from "react";

const GateEntryPage = ({ farmers = [], onMarkArrived, onVerifyFarmer }) => {
  const [tokenInput, setTokenInput] = useState("");
  const [selectedFarmer, setSelectedFarmer] = useState(null);

  const matchingFarmer = useMemo(() => {
    if (!tokenInput.trim()) return null;
    const normalized = tokenInput.trim().toUpperCase();
    return (
      farmers.find((entry) => entry.token?.toUpperCase() === normalized) ??
      farmers.find((entry) => entry.phone?.includes(tokenInput.trim())) ??
      null
    );
  }, [farmers, tokenInput]);

  const displayFarmer = selectedFarmer;

  const handleLookup = () => {
    setSelectedFarmer(matchingFarmer ?? null);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      handleLookup();
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
            Gate entry
          </p>
          <h2 className="text-2xl font-black text-slate-900 sm:text-3xl">
            Token search
          </h2>
        </div>
        <div className="flex w-full max-w-xl items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 p-2">
          <input
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter token number or phone"
            className="flex-1 bg-transparent px-3 py-2 text-sm font-medium text-slate-900 outline-none"
          />
          <button
            type="button"
            onClick={handleLookup}
            className="rounded-full bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-800"
          >
            Search
          </button>
        </div>
      </div>

      {!displayFarmer ? (
        <div className="rounded-[26px] border border-dashed border-emerald-200 bg-emerald-50 p-8 text-center text-slate-700">
          Search for a farmer token or phone number to pull detailed records.
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-[26px] border border-emerald-200 bg-emerald-50/50 p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                  Farmer profile
                </p>
                <h3 className="mt-2 text-2xl font-black text-slate-900">
                  {displayFarmer.name}
                </h3>
              </div>
              <span className="rounded-full bg-green-700 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-white">
                {displayFarmer.token}
              </span>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {[
                ["Crop", displayFarmer.crop],
                ["Declared quantity", `${displayFarmer.quantity || 0} kg`],
                ["Land area", displayFarmer.landArea || "N/A"],
                ["Slot time", displayFarmer.slot || "N/A"],
                ["Phone", displayFarmer.phone || "N/A"],
                ["Status", displayFarmer.status || "Queued"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-2xl border border-emerald-200 bg-white p-3"
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
                    {label}
                  </p>
                  <p className="mt-2 text-base font-bold text-slate-900">
                    {value}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onVerifyFarmer?.(displayFarmer.id)}
                className="rounded-full border border-emerald-300 bg-white px-4 py-2.5 text-sm font-semibold text-emerald-900 hover:bg-emerald-50"
              >
                Verify
              </button>
              <button
                type="button"
                onClick={() => onMarkArrived?.(displayFarmer.id)}
                className="rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800"
              >
                Mark Arrived
              </button>
            </div>
          </div>

          <div className="rounded-[26px] border border-emerald-200 bg-white p-5">
            <h3 className="text-lg font-bold text-slate-900">Live status</h3>
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                  Current stage
                </p>
                <p className="mt-2 text-lg font-black text-slate-900">
                  {displayFarmer.status || "Queued"}
                </p>
              </div>
              <div className="rounded-2xl border border-emerald-100 bg-lime-50 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-lime-800">
                  SMS action
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-700">
                  Arrival message and status update will be sent automatically
                  to the farmer.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GateEntryPage;

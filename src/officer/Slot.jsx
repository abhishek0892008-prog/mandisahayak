import { useNavigate } from "react-router-dom";

export const Slot = ({
  farmer,
  onMarkArrived,
  isHighlighted = false,
  onUpdateFarmer,
}) => {
  const navigate = useNavigate();
  const cardClass = isHighlighted
    ? "border-emerald-400 bg-emerald-50 shadow-emerald-200/60"
    : "border-emerald-200 bg-white";

  const getActionLabel = () => {
    switch (farmer.status) {
      case "Queued":
        return "Arrived";
      case "Arrived":
      case "Weighing":
      case "Quality check":
      case "Recorded":
        return "Weigh";
      case "Awaiting payment":
        return "Pay";
      case "Cleared":
        return "Done";
      default:
        return "Arrived";
    }
  };

  const handlePrimaryAction = () => {
    switch (farmer.status) {
      case "Queued":
        onMarkArrived?.(farmer.id);
        return;
      case "Arrived":
      case "Weighing":
      case "Quality check":
      case "Recorded":
        navigate("/officer/weighment");
        return;
      case "Awaiting payment":
        navigate("/officer/payments");
        return;
      default:
        return;
    }
  };

  return (
    <div
      className={[
        "mb-3 min-w-0 rounded-2xl border p-3 shadow-sm transition sm:p-4",
        cardClass,
      ].join(" ")}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-lg font-black text-slate-900">{farmer.name}</p>
          <p className="text-sm text-slate-600">{farmer.token}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-emerald-800">
            {farmer.crop}
          </span>
          <span className="rounded-full border border-lime-200 bg-lime-50 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-lime-800">
            {farmer.status}
          </span>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          Slot time
          <input
            type="time"
            value={farmer.slot}
            onChange={(event) =>
              onUpdateFarmer(farmer.id, "slot", event.target.value)
            }
            className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
          />
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          Qty (quintal)
          <input
            type="number"
            value={farmer.quantity}
            onChange={(event) =>
              onUpdateFarmer(
                farmer.id,
                "quantity",
                Number(event.target.value || 0),
              )
            }
            className="mt-1 w-full rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900"
          />
        </label>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">
          Phone
          <div className="mt-1 rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-2 text-sm font-medium text-slate-900">
            {farmer.phone || "N/A"}
          </div>
        </label>

        <div className="flex items-end justify-center">
          <button
            type="button"
            onClick={handlePrimaryAction}
            className="w-full rounded-full bg-green-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-green-800"
          >
            {getActionLabel()}
          </button>
        </div>
      </div>
    </div>
  );
};

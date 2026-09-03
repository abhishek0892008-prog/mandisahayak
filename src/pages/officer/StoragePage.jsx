const StoragePage = ({ storage }) => {
  const renderCropCard = (crop) => {
    const totalCapacity = Number(crop.capacity || 0);
    const remainingSpace = Number(
      crop.remaining ?? Math.max(totalCapacity - (crop.stock || 0), 0),
    );
    const currentStored = Math.max(totalCapacity - remainingSpace, 0);
    const fillPercent =
      totalCapacity > 0
        ? Math.min(100, (currentStored / totalCapacity) * 100)
        : 0;
    const availableSpace = Math.max(totalCapacity - currentStored, 0);

    return (
      <div
        key={crop.crop}
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-lg font-bold text-slate-900">{crop.crop}</p>
          <span className="text-sm font-semibold text-emerald-800">
            {fillPercent.toFixed(0)}% full
          </span>
        </div>

        <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-emerald-100">
          <div
            className="h-full rounded-full bg-green-700"
            style={{ width: `${fillPercent}%` }}
          />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-emerald-200 bg-white p-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Total capacity
            </p>
            <p className="mt-1 text-lg font-black text-slate-900">
              {totalCapacity} kg
            </p>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-white p-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Current stored
            </p>
            <p className="mt-1 text-lg font-black text-slate-900">
              {currentStored} kg
            </p>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-white p-2 sm:col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Space remaining
            </p>
            <p className="mt-1 text-lg font-black text-slate-900">
              {remainingSpace} kg
            </p>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-white p-2 sm:col-span-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
              Available space
            </p>
            <p className="mt-1 text-lg font-black text-slate-900">
              {availableSpace} kg
            </p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-emerald-200 bg-white p-6 shadow-sm shadow-emerald-200/30">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Daily storage
            </p>
            <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">
              Storage status
            </h2>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {storage.map(renderCropCard)}
        </div>
      </div>
    </div>
  );
};

export default StoragePage;

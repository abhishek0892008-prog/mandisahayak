export function FullScreenLoader({ label }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50">
      <div
        className="h-9 w-9 animate-spin rounded-full border-4 border-green-200 border-t-green-700"
        role="status"
        aria-label={label}
      />

      {label && <p className="text-sm text-slate-500">{label}</p>}
    </div>
  );
}

export default FullScreenLoader;

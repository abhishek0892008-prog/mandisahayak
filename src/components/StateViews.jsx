import { useTranslation } from "react-i18next";

import { translateError, statusTone } from "../lib/codes";

/** Inline spinner for a card or section that is still loading. */
export function Loading({ label }) {
  const { t } = useTranslation();
  const text = label ?? t("loading");

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10">
      <div
        className="h-7 w-7 animate-spin rounded-full border-4 border-green-200 border-t-green-700"
        role="status"
        aria-label={text}
      />

      <p className="text-sm text-slate-500">{text}</p>
    </div>
  );
}

/**
 * A failed request, said plainly and with a way out.
 *
 * The error code is translated; `error.message` is never rendered, because it
 * is English developer text by contract.
 */
export function ErrorState({ error, onRetry, className = "" }) {
  const { t } = useTranslation();

  if (!error) return null;

  return (
    <div
      className={`rounded-2xl border border-red-100 bg-red-50 p-4 ${className}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none">⚠️</span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-800">{t("somethingWentWrong")}</p>

          <p className="mt-1 text-sm leading-5 text-red-700">{translateError(t, error)}</p>

          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-800"
            >
              {t("tryAgain")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Nothing to show, which is frequently the correct answer rather than a fault. */
export function EmptyState({ icon = "📭", title, description, action }) {
  return (
    <section className="rounded-3xl bg-white p-6 text-center shadow-sm">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50 text-3xl">
        {icon}
      </div>

      <h2 className="mt-4 text-lg font-bold text-slate-900">{title}</h2>

      {description && <p className="mt-2 text-sm leading-5 text-slate-500">{description}</p>}

      {action}
    </section>
  );
}

const TONE_CLASSES = {
  success: "bg-green-100 text-green-800",
  danger: "bg-red-100 text-red-800",
  progress: "bg-amber-100 text-amber-800",
  neutral: "bg-slate-100 text-slate-700",
};

/** One consistent badge for every status the server reports. */
export function StatusBadge({ status, label, className = "" }) {
  const tone = TONE_CLASSES[statusTone(status)] ?? TONE_CLASSES.neutral;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ${tone} ${className}`}
    >
      {label ?? status}
    </span>
  );
}

/**
 * The provenance label the contract requires wherever demonstration data is
 * shown (farmer.md §8). A CONFIGURED centre is not a verified government
 * facility, and the UI must not let it look like one.
 */
export function DataTypeNote({ dataType }) {
  const { t } = useTranslation();

  if (dataType !== "CONFIGURED") return null;

  return (
    <p className="mt-2 text-xs leading-4 text-slate-400">ℹ️ {t("configuredDataNote")}</p>
  );
}

/**
 * The market a centre sits in, with its provenance.
 *
 * Shown separately from the centre's own provenance and deliberately worded so
 * the two cannot be confused: the market is official government data, the
 * demonstration centre standing in it is not. Conflating them would turn a
 * genuine citation into a false claim about the centre.
 */
export function MandiNote({ mandi }) {
  const { t } = useTranslation();

  if (!mandi) return null;

  return (
    <p className="mt-2 text-xs leading-4 text-slate-500">
      🏛️ {t("mandiOfficial", { name: mandi.name, grade: mandi.grade })}
      <span className="block text-slate-400">{mandi.publisher}</span>
    </p>
  );
}

/** A labelled row inside a details card. */
export function DetailRow({ label, value, emphasis = false }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <span className="text-sm text-slate-500">{label}</span>

      <span
        className={`text-right text-sm ${
          emphasis ? "font-bold text-slate-900" : "font-semibold text-slate-800"
        }`}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

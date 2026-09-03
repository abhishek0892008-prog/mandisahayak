import { useTranslation } from "react-i18next";

/**
 * Switches between the centres an officer is assigned to.
 *
 * Renders nothing when there is only one — a dropdown with a single option is
 * noise, and most officers hold exactly one assignment.
 */
export function CentrePicker({ centre }) {
  const { t } = useTranslation();

  if (centre.centres.length <= 1) return null;

  return (
    <select
      value={centre.centreId ?? ""}
      onChange={(event) => centre.select(event.target.value)}
      aria-label={t("procurementCentre")}
      className="rounded-full border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none focus:border-emerald-600"
    >
      {centre.centres.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
    </select>
  );
}

export default CentrePicker;

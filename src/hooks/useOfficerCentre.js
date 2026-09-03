import { useState } from "react";

import api from "../lib/api";
import useApiResource from "./useApiResource";

/**
 * The centre an officer is currently working at.
 *
 * Scope comes from `officer_centre_assignments`, resolved into the session at
 * login, so the list is whatever `GET /officer/centres` returns — never a
 * value the client picks or remembers. An officer assigned to nothing gets an
 * empty list and every screen says so rather than failing.
 */
export function useOfficerCentre() {
  const [selectedId, setSelectedId] = useState(null);

  const centres = useApiResource((signal) => api.officerCentres(signal), []);

  const list = centres.data ?? [];
  const centre = list.find((item) => item.id === selectedId) ?? list[0] ?? null;

  return {
    centres: list,
    centre,
    centreId: centre?.id ?? null,
    /** The centre's own timezone; officer dates are always in it, never the browser's. */
    timezone: centre?.timezone ?? "Asia/Kolkata",
    select: setSelectedId,
    loading: centres.initialLoading,
    error: centres.error,
    reload: centres.reload,
  };
}

export default useOfficerCentre;

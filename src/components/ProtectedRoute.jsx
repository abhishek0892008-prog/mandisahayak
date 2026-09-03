import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";
import FullScreenLoader from "./FullScreenLoader";

/**
 * Gate for the authenticated screens.
 *
 * This is a usability control, not a security one: every private endpoint is
 * enforced server-side, and hiding a route proves nothing (architecture §18.7).
 * Its job is to stop an unauthenticated visitor landing on a screen that can
 * only render errors.
 *
 * While `status` is "loading" it renders a spinner rather than redirecting —
 * the session lives in an HttpOnly cookie, so a cold load cannot know yet, and
 * redirecting early would sign the farmer out on every refresh.
 */
export function ProtectedRoute() {
  const { status } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  if (status === "loading") {
    return <FullScreenLoader label={t("checkingSession")} />;
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

/** The mirror image: keeps a signed-in farmer off the register/login screens. */
export function PublicOnlyRoute() {
  const { status } = useAuth();
  const { t } = useTranslation();

  if (status === "loading") {
    return <FullScreenLoader label={t("checkingSession")} />;
  }

  if (status === "authenticated") {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}

export default ProtectedRoute;

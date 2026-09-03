import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useAuth } from "../auth/context";
import { hasRole, homePathFor, loginPathFor } from "../auth/roles";
import FullScreenLoader from "./FullScreenLoader";

/**
 * Gate for the authenticated screens.
 *
 * This is a usability control, not a security one: every private endpoint is
 * enforced server-side, and hiding a route proves nothing (architecture §18.7).
 * Its job is to stop someone landing on a screen that can only render errors.
 *
 * While `status` is "loading" it renders a spinner rather than redirecting —
 * the session lives in an HttpOnly cookie, so a cold load cannot know yet, and
 * redirecting early would sign the user out on every refresh.
 *
 * `role` additionally sends a signed-in user who is on the wrong portal to
 * their own, instead of showing them a wall of 403s.
 */
export function ProtectedRoute({ role }) {
  const { status, farmer } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  if (status === "loading") {
    return <FullScreenLoader label={t("checkingSession")} />;
  }

  if (status !== "authenticated") {
    return (
      <Navigate to={loginPathFor(role)} replace state={{ from: location.pathname }} />
    );
  }

  if (role && !hasRole(farmer, role)) {
    return <Navigate to={homePathFor(farmer)} replace />;
  }

  return <Outlet />;
}

/** The mirror image: keeps a signed-in user off the sign-in screens. */
export function PublicOnlyRoute() {
  const { status, farmer } = useAuth();
  const { t } = useTranslation();

  if (status === "loading") {
    return <FullScreenLoader label={t("checkingSession")} />;
  }

  if (status === "authenticated") {
    return <Navigate to={homePathFor(farmer)} replace />;
  }

  return <Outlet />;
}

export default ProtectedRoute;

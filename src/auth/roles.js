/**
 * Role helpers.
 *
 * Roles come from `GET /me` and are used only to decide what to SHOW and where
 * to send someone after sign-in. They are never an authorization decision: the
 * server enforces every endpoint, and an admin calling an officer transition
 * gets a 403 regardless of what this file thinks (officer.md §2.1).
 */

export const FARMER = "FARMER";
export const OFFICER = "OFFICER";
export const ADMIN = "ADMIN";

export function hasRole(farmer, role) {
  return Boolean(farmer?.roles?.includes(role));
}

/**
 * Where a signed-in user belongs.
 *
 * Ordered by specificity: an account carrying several roles lands on the most
 * privileged portal, because that is the one it was most likely issued for.
 */
export function homePathFor(farmer) {
  if (hasRole(farmer, ADMIN)) return "/admin";
  if (hasRole(farmer, OFFICER)) return "/officer";
  return "/dashboard";
}

/** The sign-in screen appropriate to a portal, for redirects. */
export function loginPathFor(role) {
  return role === FARMER ? "/login" : "/staff-login";
}

import { createContext, useContext } from "react";

/**
 * Session state.
 *
 * `status` is deliberately three-valued. "loading" is not "anonymous": the
 * session cookie is HttpOnly, so on a cold load the client genuinely does not
 * know whether it is signed in until `GET /me` answers. Collapsing the two
 * would bounce an authenticated farmer to the login screen on every refresh.
 */
export const AuthContext = createContext(null);

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }

  return value;
}

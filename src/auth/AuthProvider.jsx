import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import api, { ApiError, primeCsrf } from "../lib/api";
import { isSupportedLanguage, SERVER_LOCALES } from "../lib/languages";
import { AuthContext } from "./context";

/**
 * Must match the key `src/i18n.js` reads at startup. They were previously
 * different ("fq.language" here, "farmqueueLanguage" there), so a chosen
 * language was written to one key and looked for under another — and the
 * preference silently failed to survive a reload.
 */
const LANGUAGE_KEY = "farmqueueLanguage";

/**
 * The only sanctioned use of localStorage in this application: a language
 * preference, which is neither sensitive nor authoritative (architecture
 * §18.8). Everything else comes from the server.
 *
 * The matching read lives in `src/i18n.js`, because the preference has to be
 * applied before the first paint — earlier than this provider mounts.
 */
function storeLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // A browser with storage disabled still gets a working app; the preference
    // simply does not survive a reload.
  }
}

export function AuthProvider({ children }) {
  const { i18n } = useTranslation();

  const [status, setStatus] = useState("loading");
  const [farmer, setFarmer] = useState(null);

  /**
   * Resolves the session from the server. A 401 is the expected answer for a
   * signed-out visitor, not an error worth surfacing; anything else is a real
   * failure and leaves the caller to decide.
   */
  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setFarmer(me);
      setStatus("authenticated");
      return me;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
        setFarmer(null);
        setStatus("anonymous");
        return null;
      }

      throw error;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      // The CSRF cookie must exist before the first write, and registration is
      // a write reachable without a session.
      await primeCsrf().catch(() => {});

      try {
        const me = await api.me();
        if (!cancelled) {
          setFarmer(me);
          setStatus("authenticated");
        }
      } catch {
        if (!cancelled) {
          setFarmer(null);
          setStatus("anonymous");
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  // The server owns the farmer's locale. When it disagrees with the UI the
  // server wins, so a language set on one device follows the farmer to another.
  useEffect(() => {
    if (farmer?.locale && farmer.locale !== i18n.language) {
      i18n.changeLanguage(farmer.locale);
      storeLanguage(farmer.locale);
    }
  }, [farmer?.locale, i18n]);

  /**
   * Changes the display language, and mirrors it to `users.locale` when there
   * is a session to mirror it to. A failed mirror is not worth interrupting the
   * user for — the language still changed.
   */
  const changeLanguage = useCallback(
    async (language) => {
      if (!isSupportedLanguage(language)) return;

      i18n.changeLanguage(language);
      storeLanguage(language);

      // Only `en` and `hi` exist in the server's LocaleSchema, so those are the
      // only ones worth mirroring. The rest are a client display preference —
      // sending one would be a guaranteed 400 for no gain.
      if (status === "authenticated" && SERVER_LOCALES.includes(language)) {
        try {
          await api.updateMe({ locale: language });
          setFarmer((current) => (current ? { ...current, locale: language } : current));
        } catch {
          // Preference is applied locally regardless.
        }
      }
    },
    [i18n, status],
  );

  /** Called after `POST /auth/otp/verify` returns 201 and the cookie is set. */
  const onSignedIn = useCallback(async () => {
    setStatus("loading");
    return refresh();
  }, [refresh]);

  /**
   * Logout is a server-side revocation. Clearing browser state is not logout
   * (authentication.md §2.6), so local state is cleared only after the call —
   * but it is cleared even if the call fails, because leaving a user looking at
   * a signed-in screen they asked to leave is worse.
   */
  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setFarmer(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({
      status,
      farmer,
      isAuthenticated: status === "authenticated",
      permissions: farmer?.permissions ?? [],
      can: (permission) => Boolean(farmer?.permissions?.includes(permission)),
      refresh,
      onSignedIn,
      signOut,
      changeLanguage,
    }),
    [status, farmer, refresh, onSignedIn, signOut, changeLanguage],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthProvider;

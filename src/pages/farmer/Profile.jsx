import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import api from "../../lib/api";
import { useAuth } from "../../auth/context";
import useApiResource from "../../hooks/useApiResource";
import { translateFieldErrors } from "../../lib/codes";
import FarmerLayout from "../../components/FarmerLayout";
import { DetailRow, ErrorState } from "../../components/StateViews";

/**
 * Farmer profile.
 *
 * `GET /me` is the only source; there is no client-side copy left to consult.
 * Phone, roles and status are deliberately not editable here — the server
 * ignores them in a `PATCH /me` body, and a test asserts a farmer sending
 * `roles: ["ADMIN"]` stays a FARMER (farmer.md §4).
 *
 * Sign-out revokes the session server-side. Clearing browser storage is not
 * logout (authentication.md §2.6).
 */
function Profile() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { farmer, refresh, signOut } = useAuth();

  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(farmer?.fullName ?? "");
  const [districtId, setDistrictId] = useState(farmer?.district?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const districts = useApiResource((signal) => api.districts(signal), [], { enabled: editing });

  async function handleSave(event) {
    event.preventDefault();

    setSaving(true);
    setError(null);
    setFieldErrors({});

    const patch = {};

    if (fullName.trim() && fullName.trim() !== farmer?.fullName) {
      patch.fullName = fullName.trim();
    }

    if (districtId && districtId !== farmer?.district?.id) {
      patch.districtId = districtId;
      // A village belongs to a district; changing one invalidates the other.
      patch.villageId = null;
    }

    if (Object.keys(patch).length === 0) {
      setFieldErrors({ _: t("codes.fieldErrors.NO_FIELDS_TO_UPDATE") });
      setSaving(false);
      return;
    }

    try {
      await api.updateMe(patch);
      await refresh();

      setEditing(false);
      setNotice(t("profileUpdated"));
    } catch (saveError) {
      const fields = translateFieldErrors(t, saveError);

      if (Object.keys(fields).length > 0) {
        setFieldErrors(fields);
      } else {
        setError(saveError);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);

    try {
      await signOut();
      navigate("/login", { replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  const control =
    "min-h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100";

  return (
    <FarmerLayout title={t("profile")} subtitle={t("yourInformation")}>
      {notice && (
        <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-green-50 text-2xl">
            👤
          </div>

          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold text-slate-900">
              {farmer?.fullName ?? t("farmer")}
            </h2>

            {/* The full phone is never returned by the API, by design. */}
            <p className="mt-0.5 text-sm text-slate-500">{farmer?.phoneMasked}</p>
          </div>
        </div>
      </section>

      {!editing ? (
        <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
          <div className="divide-y divide-slate-100">
            <DetailRow label={t("fullName")} value={farmer?.fullName} />
            <DetailRow label={t("phoneNumber")} value={farmer?.phoneMasked} />
            <DetailRow label={t("district")} value={farmer?.district?.name} />
            <DetailRow label={t("village")} value={farmer?.village?.name} />
            <DetailRow label={t("accountStatus")} value={farmer?.status} />
            <DetailRow
              label={t("language")}
              value={i18n.language === "hi" ? t("hindi") : t("english")}
            />
          </div>

          <button
            type="button"
            onClick={() => {
              setFullName(farmer?.fullName ?? "");
              setDistrictId(farmer?.district?.id ?? "");
              setFieldErrors({});
              setError(null);
              setNotice(null);
              setEditing(true);
            }}
            className="mt-4 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white"
          >
            {t("editProfile")}
          </button>
        </section>
      ) : (
        <form onSubmit={handleSave} className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
          <div>
            <label htmlFor="fullName" className="block text-sm font-medium text-slate-700">
              {t("fullName")}
            </label>

            <input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={`mt-1 ${control}`}
            />

            {fieldErrors.fullName && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.fullName}</p>
            )}
          </div>

          <div className="mt-4">
            <label htmlFor="districtId" className="block text-sm font-medium text-slate-700">
              {t("district")}
            </label>

            <select
              id="districtId"
              value={districtId}
              disabled={districts.loading}
              onChange={(event) => setDistrictId(event.target.value)}
              className={`mt-1 ${control}`}
            >
              <option value="">{districts.loading ? t("loading") : t("selectDistrict")}</option>

              {(districts.data ?? []).map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>

            {fieldErrors.districtId && (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.districtId}</p>
            )}
          </div>

          <p className="mt-3 text-xs text-slate-400">{t("phoneNotEditable")}</p>

          {fieldErrors._ && <p className="mt-2 text-xs text-red-500">{fieldErrors._}</p>}

          {error && <ErrorState error={error} className="mt-3" />}

          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"
            >
              {t("cancel")}
            </button>

            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-xl bg-green-700 px-4 py-3 text-sm font-semibold text-white disabled:bg-green-300"
            >
              {saving ? t("saving") : t("save")}
            </button>
          </div>
        </form>
      )}

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setConfirmSignOut(true)}
          className="w-full rounded-xl border border-red-200 px-4 py-3 text-sm font-semibold text-red-700"
        >
          {t("signOut")}
        </button>
      </section>

      {confirmSignOut && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-bold text-slate-900">{t("signOutConfirm")}</h3>

            <p className="mt-1 text-sm text-slate-500">{t("signOutWarning")}</p>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmSignOut(false)}
                disabled={signingOut}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"
              >
                {t("cancel")}
              </button>

              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="flex-1 rounded-xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:bg-red-300"
              >
                {signingOut ? t("signingOut") : t("signOut")}
              </button>
            </div>
          </div>
        </div>
      )}
    </FarmerLayout>
  );
}

export default Profile;

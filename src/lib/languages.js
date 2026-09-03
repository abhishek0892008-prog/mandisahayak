/**
 * The languages the interface is available in.
 *
 * One list, imported by i18n, the language chooser and the in-app toggle, so a
 * language can never be offered in one place and missing from another.
 *
 * `nativeName` is deliberately written in the language's own script: a farmer
 * choosing a language cannot be assumed to read the current one.
 *
 * `serverLocale` marks the two the backend actually stores. `LocaleSchema` in
 * server/src/modules/auth/auth.schemas.ts is `z.enum(['en','hi'])`, so mirroring
 * any other value to `users.locale` would be rejected. The display language
 * still applies locally for all of them — it is a client preference.
 */
export const LANGUAGES = [
  { code: "en", nativeName: "English", englishName: "English" },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi" },
  { code: "pa", nativeName: "ਪੰਜਾਬੀ", englishName: "Punjabi" },
  { code: "mr", nativeName: "मराठी", englishName: "Marathi" },
  { code: "bn", nativeName: "বাংলা", englishName: "Bengali" },
  { code: "te", nativeName: "తెలుగు", englishName: "Telugu" },
  { code: "ta", nativeName: "தமிழ்", englishName: "Tamil" },
  { code: "kn", nativeName: "ಕನ್ನಡ", englishName: "Kannada" },
  { code: "or", nativeName: "ଓଡ଼ିଆ", englishName: "Odia" },
];

export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code);

/** The locales `PATCH /me` will accept. Everything else stays client-side. */
export const SERVER_LOCALES = ["en", "hi"];

export function isSupportedLanguage(code) {
  return LANGUAGE_CODES.includes(code);
}

export default LANGUAGES;

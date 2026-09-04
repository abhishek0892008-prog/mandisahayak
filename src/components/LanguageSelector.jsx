import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";

const languages = [
  { code: "en", native: "English", short: "EN" },
  { code: "hi", native: "हिन्दी", short: "हिं" },
  { code: "pa", native: "ਪੰਜਾਬੀ", short: "ਪੰ" },
  { code: "mr", native: "मराठी", short: "मरा" },
  { code: "te", native: "తెలుగు", short: "తె" },
  { code: "bn", native: "বাংলা", short: "বা" },
  { code: "or", native: "ଓଡ଼ିଆ", short: "ଓଡ଼" },
  { code: "ta", native: "தமிழ்", short: "த" },
  { code: "kn", native: "ಕನ್ನಡ", short: "ಕ" },
];

export default function LanguageSelector() {
  const { i18n: currentI18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const selectorRef = useRef(null);

  const currentLanguage =
    languages.find((language) => language.code === currentI18n.language) ||
    languages[0];

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        selectorRef.current &&
        !selectorRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const changeLanguage = (language) => {
    i18n.changeLanguage(language);
    setOpen(false);
  };

  return (
    <div ref={selectorRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-10 items-center gap-2 rounded-full border border-white/30 bg-white/15 px-3 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/25"
      >
        <span>🌐</span>
        <span>{currentLanguage.short}</span>
        <span className="text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-52 overflow-hidden rounded-2xl border border-emerald-100 bg-white p-2 shadow-[0_15px_35px_rgba(16,64,42,0.15)]">
          {languages.map((language) => {
            const selected = language.code === currentI18n.language;

            return (
              <button
                key={language.code}
                type="button"
                onClick={() => changeLanguage(language.code)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  selected
                    ? "bg-emerald-50 font-semibold text-[#15803d]"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>{language.native}</span>
                {selected && <span>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
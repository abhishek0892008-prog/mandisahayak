/**
 * Search aliases for the crop picker, keyed by the backend's canonical crop
 * code.
 *
 * This file used to be the crop list itself, with its own ids ("rice",
 * "mustard") and its own centre→crop map. Both were wrong once the API became
 * the source of truth: the server's codes are `PADDY` and `RAPESEED_MUSTARD`,
 * crop ids are UUIDs, and centre eligibility is a server rule.
 *
 * What survives is the part the server does not provide and should not: the
 * Hindi and romanised spellings a farmer actually types or says. The canonical
 * name still comes from the API and is never translated — it is the
 * government's own wording (farmer.md §7).
 */
export const cropAliases = {
  WHEAT: ["wheat", "गेहूं", "गेहूँ", "गेहू", "gehun", "gehu", "gahu", "व्हीट"],
  PADDY: ["paddy", "rice", "धान", "चावल", "dhan", "chawal", "chaawal", "राइस", "पैडी"],
  RAPESEED_MUSTARD: ["mustard", "rapeseed", "सरसों", "सरसो", "राई", "sarson", "sarso", "मस्टर्ड"],
  MAIZE: ["maize", "corn", "मक्का", "मकई", "makka", "makai", "मेज", "मेज़"],
  BAJRA: ["bajra", "pearl millet", "बाजरा", "बाजरी", "bajri", "पर्ल मिलेट"],
  JOWAR: ["jowar", "sorghum", "ज्वार", "juar", "जोवार"],
  RAGI: ["ragi", "finger millet", "रागी", "मंडुआ", "mandua", "नाचनी"],
  GRAM: ["gram", "chickpea", "chana", "चना", "चिकपी", "बंगाल ग्राम"],
  LENTIL_MASUR: ["lentil", "masur", "masoor", "मसूर", "मसूर दाल", "लेंटिल"],
  TUR_ARHAR: ["tur", "arhar", "pigeon pea", "अरहर", "तूर", "तुअर", "toor"],
  MOONG: ["moong", "mung", "green gram", "मूंग", "मूँग", "मुंग"],
  URAD: ["urad", "black gram", "उड़द", "उरद", "urd"],
  GROUNDNUT: ["groundnut", "peanut", "मूंगफली", "moongfali", "mungfali", "ग्राउंडनट", "पीनट"],
  SOYBEAN_YELLOW: ["soybean", "soyabean", "soya", "soya bean", "सोयाबीन", "सोया"],
  SUNFLOWER_SEED: ["sunflower", "सूरजमुखी", "surajmukhi", "सनफ्लावर"],
  SESAMUM: ["sesamum", "sesame", "til", "तिल", "सेसम"],
  NIGERSEED: ["nigerseed", "niger", "रामतिल", "ramtil", "नाइजर"],
  SAFFLOWER: ["safflower", "कुसुम", "kusum", "कर्डी", "kardi"],
  BARLEY: ["barley", "जौ", "jau", "जऊ"],
  COTTON: ["cotton", "कपास", "kapas", "कॉटन", "रुई"],
};

/** Normalises for accent- and case-insensitive matching in both scripts. */
export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filters API crops by a free-text query, matching the canonical name and any
 * known alias. An empty query returns everything.
 */
export function filterCrops(crops, query) {
  const needle = normalizeText(query);
  if (!needle) return crops;

  return crops.filter((crop) => {
    const candidates = [
      crop.canonicalName,
      crop.code,
      ...(cropAliases[crop.code] ?? []),
    ].map(normalizeText);

    return candidates.some((candidate) => candidate.includes(needle));
  });
}

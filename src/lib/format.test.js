import { describe, expect, it } from "vitest";

import {
  formatDate,
  formatMinutes,
  formatQuantity,
  formatRupees,
  formatTime,
  formatTimeRange,
  kgToQuintal,
  quintalToKg,
  todayInZone,
} from "./format";

describe("times render in the centre's zone, not the browser's", () => {
  it("renders 02:30 UTC as 8:00 am in Asia/Kolkata", () => {
    expect(formatTime("2026-09-07T02:30:00.000Z", "Asia/Kolkata", "en")).toMatch(/8:00/);
  });

  it("keeps a bare service date on the same calendar day", () => {
    // Anchored at midday UTC so no zone can shift it across midnight.
    expect(formatDate("2026-09-07", "Asia/Kolkata", "en")).toContain("2026");
    expect(formatDate("2026-09-07", "Asia/Kolkata", "en")).toContain("7");
  });

  it("renders a window as a range", () => {
    const range = formatTimeRange(
      "2026-09-07T02:30:00.000Z",
      "2026-09-07T03:42:00.000Z",
      "Asia/Kolkata",
      "en",
    );

    expect(range).toMatch(/8:00/);
    expect(range).toMatch(/9:12/);
  });

  it("returns null for absent values instead of inventing a placeholder", () => {
    expect(formatTime(null)).toBeNull();
    expect(formatDate(null)).toBeNull();
    expect(formatTimeRange(null, null)).toBeNull();
    expect(formatRupees(null)).toBeNull();
    expect(formatQuantity(null)).toBeNull();
    expect(formatMinutes(null)).toBeNull();
  });

  it("returns null for an unparseable instant", () => {
    expect(formatTime("not-a-date", "Asia/Kolkata", "en")).toBeNull();
  });

  it("produces a YYYY-MM-DD the API accepts", () => {
    expect(todayInZone("Asia/Kolkata")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("money", () => {
  it("formats the server's exact decimal string, not a float division", () => {
    const formatted = formatRupees("64120.93", "en");

    expect(formatted).toContain("64,120.93");
  });

  it("always shows two decimal places", () => {
    expect(formatRupees("0", "en")).toContain("0.00");
  });

  it("rejects a non-numeric amount rather than rendering NaN", () => {
    expect(formatRupees("abc", "en")).toBeNull();
  });
});

describe("quantity", () => {
  it("converts quintal to the integer kg the wire expects", () => {
    expect(quintalToKg(30)).toBe(3000);
    expect(quintalToKg(24.805)).toBe(2481);
  });

  it("honours a server-supplied kgPerQuintal instead of assuming 100", () => {
    expect(quintalToKg(30, 50)).toBe(1500);
  });

  it("converts kg back to quintal without losing precision", () => {
    expect(kgToQuintal(2480.5)).toBe(24.805);
  });

  it("drops a trailing zero but keeps real precision", () => {
    expect(formatQuantity(30, "en")).toBe("30");
    expect(formatQuantity(24.805, "en")).toBe("24.805");
  });
});

describe("durations", () => {
  it("renders minutes under an hour", () => {
    expect(formatMinutes(9, "en", { hour: "h", minute: "min" })).toBe("9 min");
  });

  it("renders whole hours without stray minutes", () => {
    expect(formatMinutes(120, "en", { hour: "h", minute: "min" })).toBe("2 h");
  });

  it("renders hours and minutes together", () => {
    expect(formatMinutes(75, "en", { hour: "h", minute: "min" })).toBe("1 h 15 min");
  });

  it("floors a negative wait at zero rather than showing a negative ETA", () => {
    expect(formatMinutes(-5, "en", { hour: "h", minute: "min" })).toBe("0 min");
  });
});

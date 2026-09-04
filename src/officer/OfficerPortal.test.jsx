import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { fail, mockApi } from "../test/server";
import { renderScreen } from "../test/render";
import OfficerPortal from "./OfficerPortal";

/** The signed-in officer the portal greets and scopes its reads by. */
const officer = {
  userId: "0e5f0b2c-0000-4000-a000-000000000001",
  fullName: "Ramesh Sharma",
  phoneMasked: "***22",
  locale: "en",
  status: "ACTIVE",
  roles: ["OFFICER"],
  permissions: ["booking.read.centre", "booking.advance_state"],
  centreIds: ["11111111-0000-4000-a000-000000000001"],
};

const centre = {
  id: "11111111-0000-4000-a000-000000000001",
  code: "DEMO-UP-AGRA-01",
  name: "Agra Demonstration Procurement Centre",
  district: "Agra",
  timezone: "Asia/Kolkata",
};

const booking = {
  bookingCode: "FQ-2026-2463892",
  tokenNumber: 7,
  status: "CONFIRMED",
  displayStatus: "BOOKED",
  farmer: { name: "Suresh Yadav", phone: "9812345678", village: "Bichpuri" },
  crop: { name: "Wheat", season: "RMS", marketingYear: "2026-27" },
  centre: { code: centre.code, name: centre.name, timezone: centre.timezone },
  requestedQuantityKg: 3000,
  serviceDate: "2026-09-07",
  laneNo: 1,
  scheduledStartAt: "2026-09-07T02:30:00.000Z",
  windowEndAt: "2026-09-07T03:57:00.000Z",
  processingMinutes: 72,
};

/** The day, with the booking at whatever stage the test needs. */
function day(rows) {
  return {
    centreId: centre.id,
    serviceDate: "2026-09-07",
    count: rows.length,
    bookings: rows,
  };
}

function routes(overrides = {}) {
  return {
    "GET /me": officer,
    "GET /auth/csrf": { csrfToken: "test-csrf" },
    "GET /officer/centres": [centre],
    "GET /officer/centres/:centreId/bookings": day([booking]),
    ...overrides,
  };
}

describe("OfficerPortal", () => {
  it("shows the centre's day, as the server reports it", async () => {
    mockApi(routes());

    renderScreen(<OfficerPortal />, {
      route: "/officer/queue",
      path: "/officer/*",
    });

    expect(await screen.findByText("Suresh Yadav")).toBeInTheDocument();

    // 3000 kg is 30 quintal. The screen speaks quintal; the wire speaks kg.
    expect(screen.getByDisplayValue("30")).toBeInTheDocument();
    expect(screen.getByText("Namaste, Ramesh Sharma")).toBeInTheDocument();
  });

  it("records an arrival against the API and reloads the day", async () => {
    const arrived = {
      ...booking,
      status: "ARRIVED",
      displayStatus: "WAITING",
    };

    let arrivedYet = false;

    const api = mockApi(
      routes({
        "GET /officer/centres/:centreId/bookings": () =>
          day([arrivedYet ? arrived : booking]),
        "POST /officer/bookings/:bookingCode/arrive": () => {
          arrivedYet = true;
          return { booking: arrived, procurement: { status: "IN_PROGRESS" } };
        },
        "GET /officer/bookings/:bookingCode": {
          booking: arrived,
          procurement: {
            status: "IN_PROGRESS",
            qualityStatus: "PENDING",
            grossQuantityKg: null,
            acceptedQuantityKg: null,
            rejectedQuantityKg: null,
            grade: null,
            moisturePercent: null,
            rejectionReason: null,
          },
          payment: null,
        },
      }),
    );

    renderScreen(<OfficerPortal />, {
      route: "/officer/queue",
      path: "/officer/*",
    });

    const search = await screen.findByPlaceholderText(
      "Enter token number or phone",
    );

    await userEvent.type(search, "7");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Mark Arrived" }),
    );

    await waitFor(() =>
      expect(
        api.lastCall(
          "POST",
          `/officer/bookings/${booking.bookingCode}/arrive`,
        ),
      ).not.toBeNull(),
    );

    // The write echoes the CSRF cookie, as every write must.
    const write = api.lastCall(
      "POST",
      `/officer/bookings/${booking.bookingCode}/arrive`,
    );
    expect(write.headers["x-csrf-token"]).toBeTruthy();

    expect(await screen.findByText("Arrived")).toBeInTheDocument();
  });

  it("surfaces the server's error code rather than failing silently", async () => {
    mockApi(
      routes({
        "POST /officer/bookings/:bookingCode/arrive": fail(
          409,
          "INVALID_STATE_TRANSITION",
        ),
      }),
    );

    renderScreen(<OfficerPortal />, {
      route: "/officer/queue",
      path: "/officer/*",
    });

    const search = await screen.findByPlaceholderText(
      "Enter token number or phone",
    );

    await userEvent.type(search, "7");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Mark Arrived" }),
    );

    expect(
      await screen.findByText("INVALID_STATE_TRANSITION"),
    ).toBeInTheDocument();
  });
});

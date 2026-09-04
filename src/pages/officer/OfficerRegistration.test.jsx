/**
 * The officer application form, /staff-register.
 *
 * Three dependent selects: District -> Procurement Centre -> Crop. Each level
 * narrows the next, and every level is an ID, never a name — the server takes
 * UUIDs and rejects a centre outside the district or a crop the centre does
 * not accept.
 *
 * The subtle failure these tests exist for: when the district or centre
 * changes, the <select> below it goes visually blank on its own, because no
 * <option> matches the held value any more. That LOOKS cleared but is not —
 * the state still holds the previous id, and it is the state that gets
 * submitted. The form then sends a crop from a centre the applicant is no
 * longer applying to, and the server answers 422
 * CROP_NOT_CONFIGURED_AT_CENTRE for a form that looked perfectly filled in.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import OfficerRegistration from "./OfficerRegistration";
import { renderBare } from "../../test/render";
import { created, fail, mockApi } from "../../test/server";
import {
  districts,
  registrationCentres,
  registrationCentresAgra,
} from "../../test/fixtures";

const ALIGARH = "44444444-0000-4000-a000-000000000011";
const AGRA = "44444444-0000-4000-a000-000000000012";
const PADDY = "c9422b7f-858f-4740-a964-780671c8ca4c";
const WHEAT = "a5ebf3f4-c6d4-438a-b5dc-4ee4f06ef5a2";

/** Serves centres per district, the way the real endpoint does. */
function routes(overrides = {}) {
  return {
    "GET /auth/csrf": { csrfToken: "test-csrf-token" },
    "GET /me": fail(401, "UNAUTHENTICATED"),
    "GET /reference/districts": districts,
    "GET /reference/registration-centres": (call) =>
      call.search.includes(AGRA) ? registrationCentresAgra : registrationCentres,
    ...overrides,
  };
}

const box = (label) => screen.getByLabelText(label);
const options = (label) =>
  within(box(label))
    .getAllByRole("option")
    .map((o) => o.textContent);

async function ready() {
  await waitFor(() => {
    expect(within(box("District")).getByRole("option", { name: "Aligarh" })).toBeInTheDocument();
  });
}

describe("/staff-register — District -> Centre -> Crop", () => {
  it("keeps centre and crop shut until a district is chosen", async () => {
    const api = mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    expect(box("Procurement Centre")).toBeDisabled();
    expect(options("Procurement Centre")).toEqual(["Select a district first"]);
    expect(box("Crop")).toBeDisabled();
    expect(options("Crop")).toEqual(["Select a procurement centre first"]);

    // Nothing is fetched speculatively.
    expect(api.countOf("GET", "/reference/registration-centres")).toBe(0);
  });

  it("fetches centres with the district UUID — not the district name", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);

    await waitFor(() => {
      expect(api.lastCall("GET", "/reference/registration-centres")).not.toBeNull();
    });

    const call = api.lastCall("GET", "/reference/registration-centres");
    expect(call.search).toBe(`districtId=${ALIGARH}`);
    expect(call.search).not.toMatch(/Aligarh/);
  });

  it("populates the centre dropdown and enables it", async () => {
    const user = userEvent.setup();
    mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);

    await waitFor(() => {
      expect(options("Procurement Centre")).toEqual([
        "Select Procurement Centre",
        "Aligarh Demonstration Procurement Centre",
      ]);
    });
    expect(box("Procurement Centre")).toBeEnabled();
  });

  it("populates crops from the chosen centre's acceptedCrops", async () => {
    const user = userEvent.setup();
    mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());

    // Crop is still shut: it depends on the centre, not the district.
    expect(options("Crop")).toEqual(["Select a procurement centre first"]);

    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);

    await waitFor(() => {
      expect(options("Crop")).toEqual(["Select Crop", "Paddy", "Wheat"]);
    });
    expect(box("Crop")).toBeEnabled();
  });

  /*
   * The regression this file was written for. Aligarh's centre accepts Paddy
   * and Wheat; Agra's accepts Wheat only. Choosing Paddy and then switching
   * district must not leave Paddy selected underneath a blank-looking box.
   */
  it("clears the crop when the district changes", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({ "POST /auth/staff/register": created({ status: "PENDING" }) }),
    );

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());
    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);
    await waitFor(() => expect(box("Crop")).toBeEnabled());
    await user.selectOptions(box("Crop"), PADDY);

    // Switch to a district whose centre does not accept Paddy.
    await user.selectOptions(box("District"), AGRA);
    await waitFor(() => {
      expect(options("Procurement Centre")).toContain("Agra Demonstration Procurement Centre");
    });
    await user.selectOptions(box("Procurement Centre"), registrationCentresAgra[0].id);
    await waitFor(() => expect(options("Crop")).toEqual(["Select Crop", "Wheat"]));

    // Fill everything else and try to submit without touching Crop.
    await user.type(screen.getByLabelText("Full name"), "Stale Crop Officer");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /Submit application/i }));

    // The stale Paddy id must NOT have been submitted. Before the fix this
    // sent cropId=PADDY with Agra's centre and the server returned 422.
    expect(api.countOf("POST", "/auth/staff/register")).toBe(0);
  });

  it("clears the crop when only the centre changes", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({
        // Two centres in one district, with different crop lists.
        "GET /reference/registration-centres": [
          registrationCentres[0],
          { ...registrationCentresAgra[0], district: registrationCentres[0].district },
        ],
        "POST /auth/staff/register": created({ status: "PENDING" }),
      }),
    );

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());

    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);
    await waitFor(() => expect(options("Crop")).toEqual(["Select Crop", "Paddy", "Wheat"]));
    await user.selectOptions(box("Crop"), PADDY);

    // Same district, different centre — Paddy is not on offer there.
    await user.selectOptions(box("Procurement Centre"), registrationCentresAgra[0].id);
    await waitFor(() => expect(options("Crop")).toEqual(["Select Crop", "Wheat"]));

    await user.type(screen.getByLabelText("Full name"), "Switcher Officer");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /Submit application/i }));

    expect(api.countOf("POST", "/auth/staff/register")).toBe(0);
  });

  it("submits the three ids the server expects", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({ "POST /auth/staff/register": created({ status: "PENDING" }) }),
    );

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());
    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);
    await waitFor(() => expect(box("Crop")).toBeEnabled());
    await user.selectOptions(box("Crop"), WHEAT);

    await user.type(screen.getByLabelText("Full name"), "Valid Officer");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(screen.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /Submit application/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/staff/register")).not.toBeNull();
    });

    const body = api.lastCall("POST", "/auth/staff/register").body;
    expect(body.districtId).toBe(ALIGARH);
    expect(body.centreId).toBe(registrationCentres[0].id);
    expect(body.cropId).toBe(WHEAT);
  });

  it("surfaces a centre-load failure and recovers on retry", async () => {
    const user = userEvent.setup();
    let attempt = 0;

    mockApi(
      routes({
        "GET /reference/registration-centres": () => {
          attempt += 1;
          return attempt === 1 ? fail(500, "INTERNAL_ERROR") : registrationCentres;
        },
      }),
    );

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);

    // The failure is shown, not swallowed into an empty dropdown.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Try again/i }));

    await waitFor(() => {
      expect(options("Procurement Centre")).toContain("Aligarh Demonstration Procurement Centre");
    });
  });

  it("says so plainly when a district lists no active centre", async () => {
    const user = userEvent.setup();
    mockApi(routes({ "GET /reference/registration-centres": [] }));

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);

    await waitFor(() => {
      expect(screen.getByText(/No active centre is listed in this district/i)).toBeInTheDocument();
    });
  });
});

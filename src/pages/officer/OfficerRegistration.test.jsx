/**
 * The officer application form, /staff-register.
 *
 * District -> Procurement Centre narrows the centre the usual way (the
 * server rejects a centre outside the district). Crop selection is
 * different: it is the same crop catalog a farmer sees while booking a
 * slot, fetched once and independent of district/centre, and an officer may
 * check as many as they handle — the field is submitted as `cropIds`, an
 * array of one or more UUIDs.
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
  crops,
} from "../../test/fixtures";

const ALIGARH = "44444444-0000-4000-a000-000000000011";
const AGRA = "44444444-0000-4000-a000-000000000012";
const WHEAT = "de8e724c-3ea7-4fd6-bca0-ebbc679c142d";
const PADDY = "aa1e724c-3ea7-4fd6-bca0-ebbc679c1111";

/** Serves centres per district, the way the real endpoint does. */
function routes(overrides = {}) {
  return {
    "GET /auth/csrf": { csrfToken: "test-csrf-token" },
    "GET /me": fail(401, "UNAUTHENTICATED"),
    "GET /reference/districts": districts,
    "GET /reference/crops": crops,
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

/** The consent checkbox is the last checkbox in the form; crops come first. */
function consentCheckbox() {
  const boxes = screen.getAllByRole("checkbox");
  return boxes[boxes.length - 1];
}

describe("/staff-register — District -> Centre, crops independent", () => {
  it("keeps the centre shut until a district is chosen, and lists the full crop catalog regardless", async () => {
    mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    expect(box("Procurement Centre")).toBeDisabled();
    expect(options("Procurement Centre")).toEqual(["Select a district first"]);

    await waitFor(() => {
      expect(screen.getByText("Wheat")).toBeInTheDocument();
      expect(screen.getByText("Paddy")).toBeInTheDocument();
    });
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

  it("keeps crop selections when the district or centre changes", async () => {
    const user = userEvent.setup();
    mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await waitFor(() => expect(screen.getByText("Paddy")).toBeInTheDocument());
    await user.click(screen.getByText("Paddy"));

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());
    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);

    // Switching district/centre never touched the crop checkboxes.
    const paddyCheckbox = screen.getByText("Paddy").closest("label").querySelector("input");
    expect(paddyCheckbox).toBeChecked();

    await user.selectOptions(box("District"), AGRA);
    expect(paddyCheckbox).toBeChecked();
  });

  it("submits multiple crop ids alongside district and centre", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      routes({ "POST /auth/staff/register": created({ status: "PENDING" }) }),
    );

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());
    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);

    await waitFor(() => expect(screen.getByText("Wheat")).toBeInTheDocument());
    await user.click(screen.getByText("Wheat"));
    await user.click(screen.getByText("Paddy"));

    await user.type(screen.getByLabelText("Full name"), "Valid Officer");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(consentCheckbox());
    await user.click(screen.getByRole("button", { name: /Submit application/i }));

    await waitFor(() => {
      expect(api.lastCall("POST", "/auth/staff/register")).not.toBeNull();
    });

    const body = api.lastCall("POST", "/auth/staff/register").body;
    expect(body.districtId).toBe(ALIGARH);
    expect(body.centreId).toBe(registrationCentres[0].id);
    expect(body.cropIds.sort()).toEqual([PADDY, WHEAT].sort());
  });

  it("requires at least one crop", async () => {
    const user = userEvent.setup();
    const api = mockApi(routes());

    renderBare(<OfficerRegistration />, { route: "/staff-register" });
    await ready();

    await user.selectOptions(box("District"), ALIGARH);
    await waitFor(() => expect(box("Procurement Centre")).toBeEnabled());
    await user.selectOptions(box("Procurement Centre"), registrationCentres[0].id);

    await user.type(screen.getByLabelText("Full name"), "No Crop Officer");
    await user.type(screen.getByLabelText("Mobile Number"), "9812345678");
    await user.click(consentCheckbox());
    await user.click(screen.getByRole("button", { name: /Submit application/i }));

    expect(await screen.findByText(/select at least one crop/i)).toBeInTheDocument();
    expect(api.countOf("POST", "/auth/staff/register")).toBe(0);
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

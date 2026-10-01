/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Postman's per-request protocol switches in the Settings tab (issue #1765):
 * the cookie-jar and URL-encoding toggles, the stored "Don't send automatic
 * headers" list, and the read-only names Vayu keeps without applying.
 *
 * Each control writes through `updateField`, because every one of them is
 * stored on the request - the opposite of the Headers tab's per-send untick,
 * whose own test pins that it never touches `updateField`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import type { RequestDefaults } from "@/types";
import { createDefaultRequestState } from "../../../utils/request-state";

const DECLARED: RequestDefaults = {
	headers: [
		{ name: "User-Agent", value: "Vayu/0.37.0", generated: false },
		{ name: "X-Vayu-Request-Id", generated: true, configKey: "correlationIdEnabled" },
	],
};

let declared: RequestDefaults | undefined = DECLARED;
let currentCtx: RequestBuilderContextValue;

vi.mock("@/queries", () => ({
	useRequestDefaultsQuery: () => ({ data: declared }),
}));
vi.mock("../../../context", () => ({ useRequestBuilderContext: () => currentCtx }));

const { default: SettingsPanel } = await import("./SettingsPanel");

function mount(initial: Partial<RequestState> = {}) {
	const request: RequestState = { ...createDefaultRequestState(), id: "req_1", ...initial };
	const updateField = vi.fn();
	currentCtx = {
		request,
		updateField,
		setRequest: vi.fn(),
	} as unknown as RequestBuilderContextValue;
	render(<SettingsPanel />);
	return updateField;
}

const headerBox = (name: string) => screen.getByRole("checkbox", { name: `Don't send ${name}` });

beforeEach(() => {
	declared = DECLARED;
});

describe("the cookie jar and encoding toggles", () => {
	it("writes the cookie-jar toggle through to the request", () => {
		const on = mount();
		fireEvent.click(screen.getByRole("switch", { name: "Disable cookie jar" }));
		expect(on).toHaveBeenCalledWith("disableCookies", true);
	});

	it("turns the jar back on from the stored off state", () => {
		const off = mount({ disableCookies: true });
		const toggle = screen.getByRole("switch", { name: "Disable cookie jar" });
		expect(toggle).toBeChecked();
		fireEvent.click(toggle);
		expect(off).toHaveBeenCalledWith("disableCookies", false);
	});

	it("writes the encoding toggle through to the request", () => {
		const updateField = mount();
		fireEvent.click(screen.getByRole("switch", { name: "Send URL without encoding" }));
		expect(updateField).toHaveBeenCalledWith("disableUrlEncoding", true);
	});

	it("changes only the flag, leaving the URL and its rows alone", () => {
		// The rows hold the query as written in either mode (#1771), so the
		// switch has nothing to re-derive.
		const url = "https://x/y?q=a%20b";
		const on = mount({ url, params: [{ id: "p1", key: "q", value: "a%20b", enabled: true }] });
		fireEvent.click(screen.getByRole("switch", { name: "Send URL without encoding" }));
		expect(on.mock.calls.map(([field]) => field)).toEqual(["disableUrlEncoding"]);
	});
});

describe("the automatic headers list", () => {
	it("offers the built-in four plus the correlation header the engine declares", () => {
		mount();
		for (const name of ["User-Agent", "Accept", "Accept-Encoding", "Content-Type"]) {
			expect(headerBox(name)).not.toBeChecked();
		}
		// Declared, not hardcoded: a build whose engine names its correlation
		// header differently offers that name.
		expect(headerBox("X-Vayu-Request-Id")).not.toBeChecked();
		// The declared value replaces the built-in description.
		expect(screen.getByText("Vayu/0.37.0")).toBeInTheDocument();
	});

	it("leaves the correlation row out while the engine has not answered", () => {
		declared = undefined;
		mount();
		expect(headerBox("User-Agent")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox", { name: /X-Vayu-Request-Id/ })).toBeNull();
	});

	it("stores a tick as the lowercased name, through updateField", () => {
		const updateField = mount();
		fireEvent.click(headerBox("User-Agent"));
		expect(updateField).toHaveBeenCalledWith("disabledSystemHeaders", ["user-agent"]);
	});

	it("takes an untick back out of the stored list and keeps the rest", () => {
		const updateField = mount({ disabledSystemHeaders: ["accept", "user-agent", "host"] });
		expect(headerBox("Accept")).toBeChecked();
		fireEvent.click(headerBox("Accept"));
		expect(updateField).toHaveBeenCalledWith("disabledSystemHeaders", ["user-agent", "host"]);
	});

	it("keeps a stored name nothing declares reachable, so it can be unticked", () => {
		// Stored while its default was off in engine config, say: a name with no
		// row would sit on the request with no way to remove it.
		mount({ disabledSystemHeaders: ["x-legacy-id"] });
		expect(headerBox("x-legacy-id")).toBeChecked();
	});
});

describe("the names kept but not applied", () => {
	it("shows nothing while the request stores none of them", () => {
		mount({ disabledSystemHeaders: ["user-agent"] });
		expect(screen.queryByText(/Kept for the Postman export/)).toBeNull();
	});

	it("shows them read-only, with the reason each does nothing", () => {
		mount({ disabledSystemHeaders: ["postman-token", "host", "connection"] });

		expect(screen.getByText(/Kept for the Postman export/)).toBeInTheDocument();
		for (const name of ["Postman-Token", "Host", "Connection"]) {
			expect(screen.getByText(name)).toBeInTheDocument();
			// Read-only: no checkbox claims to govern it, in any spelling - the
			// stored form is lowercased.
			expect(
				screen.queryByRole("checkbox", { name: new RegExp(`^Don't send ${name}$`, "i") })
			).toBeNull();
		}
		expect(
			screen.getByText(
				"Vayu never sends Postman-Token and Connection. Vayu can't leave out Host: HTTP/1.1 needs it."
			)
		).toBeInTheDocument();
	});
});

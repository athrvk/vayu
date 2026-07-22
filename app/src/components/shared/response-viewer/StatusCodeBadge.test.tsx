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
 * The one status chip, replacing two copies that had drifted apart.
 *
 * `ResponseHeader` and `UnifiedResponseViewer` held the same twelve lines, and
 * the copy had lost the `status === 0` branch - so a connection failure showed
 * a literal `0` chip where the original showed `ERR`. The duplication was the
 * defect, which is why there is one component.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusCodeBadge } from "./StatusCodeBadge";

/** Render one chip and hand back the badge element itself. */
function chipFor(status: number, statusText?: string): HTMLElement {
	const { container } = render(<StatusCodeBadge status={status} statusText={statusText} />);
	return container.querySelector('[data-slot="badge"]') as HTMLElement;
}

describe("what the chip says", () => {
	it("pairs a code with its reason phrase", () => {
		expect(chipFor(404, "Not Found").textContent).toBe("404 Not Found");
	});

	it("says ERR when nothing came back, never a literal 0", () => {
		// The case the duplicated copy lost.
		expect(chipFor(0, "Error").textContent).toBe("ERR");
	});

	it("drops the reason phrase only for no-response", () => {
		/*
		 * "ERR Error" is two words for one fact, and the engine fills statusText
		 * with the vaguer of them. Everywhere else the halves differ - "503" and
		 * "Service Unavailable" - so the phrase earns its place.
		 */
		expect(chipFor(503, "Service Unavailable").textContent).toBe("503 Service Unavailable");
	});

	it("renders a bare code when no reason is supplied", () => {
		expect(chipFor(200).textContent).toBe("200");
	});
});

describe("what the chip looks like", () => {
	it.each([
		[200, "bg-status-success-fill"],
		[301, "bg-status-redirect-fill"],
		[404, "bg-status-warning-fill"],
		[500, "bg-status-error-fill"],
		[0, "bg-status-no-response-fill"],
	])("paints %i with %s", (status, expected) => {
		expect(chipFor(status).className).toContain(expected);
	});

	it("gives a failed connection a different fill from a server error", () => {
		// These were the same token, so "the server erred" and "there was no
		// server" were indistinguishable.
		const server = chipFor(500).className.match(/bg-status-[\w-]+-fill/)?.[0];
		const none = chipFor(0).className.match(/bg-status-[\w-]+-fill/)?.[0];
		expect(server).toBeTruthy();
		expect(server).not.toBe(none);
	});

	it("carries no hover background, since it is not interactive", () => {
		expect(chipFor(200).className).not.toMatch(/hover:bg-/);
	});
});

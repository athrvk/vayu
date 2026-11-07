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
 * The status band's mTLS chip (issues #707, #3260).
 *
 * It appears only when the engine named a registry entry, and its tooltip says
 * the certificate was *offered*: the server decides whether to accept it, and
 * the engine answers `""` for an `http://` send, where nothing is offered.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";

function renderBar(clientCertificate: string | undefined) {
	return render(
		<ResponseStatusBar
			status={200}
			statusText="OK"
			time={120}
			size={2048}
			clientCertificate={clientCertificate}
		/>
	).container;
}

describe("the status band's client-certificate chip", () => {
	it("names the entry and says its certificate was offered", () => {
		const el = renderBar("*.example.com").querySelector("[title*='Client certificate']");
		expect(el?.textContent).toBe("mTLS: *.example.com");
		expect(el?.getAttribute("title")).toBe(
			"Client certificate registered for *.example.com was offered " +
				"(Settings › Network & connectivity)."
		);
	});

	it.each([[""], [undefined]])("is absent when the exchange offered none (%j)", (value) => {
		const container = renderBar(value);
		expect(container.textContent).not.toContain("mTLS");
		expect(container.querySelector("[title*='Client certificate']")).toBeNull();
	});
});

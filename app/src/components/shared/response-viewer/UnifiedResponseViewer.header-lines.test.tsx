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
 * The compact viewer's Headers tab shows the lines as received when a caller
 * has them (issue #2460), and the folded map when it has not - a load-run
 * sample and an inbox capture keep the map alone.
 *
 * Mutation check: stop forwarding `headerLines` to `CompactHeadersViewer` and
 * the first case fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import UnifiedResponseViewer from "./UnifiedResponseViewer";

const LINES = [
	{ name: "X-Dup", value: "one" },
	{ name: "x-dup", value: "two" },
	{ name: "Set-Cookie", value: "a=1" },
	{ name: "Set-Cookie", value: "b=2" },
];
const FOLDED = { "x-dup": "one, two", "set-cookie": "a=1, b=2" };

function openHeaders() {
	const trigger = screen.getByRole("tab", { name: /headers/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

const names = (container: HTMLElement) =>
	Array.from(container.querySelectorAll("span.font-medium")).map((n) => n.textContent);

describe("UnifiedResponseViewer headers", () => {
	it("lists the response lines as received", () => {
		const { container } = render(
			<UnifiedResponseViewer
				response={{ body: "x", headers: FOLDED, headerLines: LINES }}
				request={{ headers: { accept: "*/*" } }}
			/>
		);
		openHeaders();

		// The request map first, then one row per received response line.
		expect(names(container)).toEqual([
			"accept:",
			"X-Dup:",
			"x-dup:",
			"Set-Cookie:",
			"Set-Cookie:",
		]);
	});

	it("lists the folded map when the caller has no lines", () => {
		const { container } = render(
			<UnifiedResponseViewer response={{ body: "x", headers: FOLDED }} />
		);
		openHeaders();

		expect(names(container)).toEqual(["x-dup:", "set-cookie:"]);
	});
});

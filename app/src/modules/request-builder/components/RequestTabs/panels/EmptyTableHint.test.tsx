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
 * The instruction line, and the fact that it goes away.
 *
 * Params and Headers each opened with a permanent sentence - "Add headers to
 * include with your request. Use `{{variable}}` for dynamic values." - in a
 * dense developer tool, repeated on the sibling tab, restating what the field
 * placeholder and the coloured token already say the moment you have a row.
 * Useful once, furniture thereafter. Same shape as "Auto-saves when you click
 * away", which came out of the variable popover last round.
 *
 * The condition is the whole point, and it is not `items.length`: the editor
 * always keeps one blank row at the end, so a genuinely empty table still has a
 * row in it. Counting rows would hide the hint exactly when it is wanted.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyTableHint } from "./EmptyTableHint";
import type { KeyValueItem } from "@/types";

const blank: KeyValueItem = { id: "1", key: "", value: "", enabled: true };
const filled: KeyValueItem = { id: "2", key: "Accept", value: "application/json", enabled: true };

const hint = (items: KeyValueItem[]) =>
	render(
		<EmptyTableHint items={items} noun="headers">
			Add headers to send with this request.
		</EmptyTableHint>
	);

describe("when the hint shows", () => {
	it("shows on a table with nothing in it", () => {
		hint([]);
		expect(screen.getByText(/Add headers to send/)).toBeInTheDocument();
	});

	it("still shows when the only row is the editor's trailing blank", () => {
		// The case `items.length` would get wrong.
		hint([blank]);
		expect(screen.getByText(/Add headers to send/)).toBeInTheDocument();
	});

	it("goes away once a row has a key", () => {
		hint([filled, blank]);
		expect(screen.queryByText(/Add headers to send/)).not.toBeInTheDocument();
	});

	it("goes away for a row with only a value", () => {
		hint([{ id: "3", key: "", value: "something", enabled: true }]);
		expect(screen.queryByText(/Add headers to send/)).not.toBeInTheDocument();
	});

	it("treats whitespace as empty", () => {
		hint([{ id: "4", key: "   ", value: "  ", enabled: true }]);
		expect(screen.getByText(/Add headers to send/)).toBeInTheDocument();
	});

	it("counts a disabled row as content, because it is still there", () => {
		hint([{ ...filled, enabled: false }]);
		expect(screen.queryByText(/Add headers to send/)).not.toBeInTheDocument();
	});
});

describe("what it says", () => {
	it("names the variable syntax once, where it is new", () => {
		hint([]);
		expect(screen.getByText("{{variable}}")).toBeInTheDocument();
	});

	it("uses the caller's noun in the singular", () => {
		hint([]);
		expect(
			screen.getByText(/in a header for a value resolved at send time/)
		).toBeInTheDocument();
	});
});

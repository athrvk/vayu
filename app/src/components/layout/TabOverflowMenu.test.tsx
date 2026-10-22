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
 * The trigger's accessible name counts what is hidden. The section strips'
 * widths are stubbed in `ResponseViewer/tab-overflow.test.tsx` and its sibling,
 * which never reach a count of one; this feeds the menu its tabs directly.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabOverflowMenu } from "./TabOverflowMenu";

const tab = (id: string, attention = false) => ({ id, label: id.toUpperCase(), attention });

describe("TabOverflowMenu trigger name", () => {
	it("says '1 more tab' for a single hidden tab", () => {
		render(<TabOverflowMenu tabs={[tab("a")]} onSelect={() => {}} />);
		expect(screen.getByRole("button", { name: "1 more tab" })).toBeInTheDocument();
	});

	it("keeps the singular when that one tab holds an error", () => {
		render(<TabOverflowMenu tabs={[tab("a", true)]} onSelect={() => {}} />);
		expect(
			screen.getByRole("button", { name: "1 more tab, A has an error" })
		).toBeInTheDocument();
	});

	it("says '2 more tabs' for two", () => {
		render(<TabOverflowMenu tabs={[tab("a"), tab("b")]} onSelect={() => {}} />);
		expect(screen.getByRole("button", { name: "2 more tabs" })).toBeInTheDocument();
	});
});

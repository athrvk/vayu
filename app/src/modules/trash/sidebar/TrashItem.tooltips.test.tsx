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
 * The three icon buttons on a trash row say what they do on keyboard focus
 * (#3498). Each carried a native `title`, which a keyboard user never sees; the
 * app's Tooltip opens on focus. The accessible name stays the row-specific one
 * ("Restore List pets") and the tooltip is the verb alone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import type { TrashEntry } from "@/types";
import TrashItem from "./TrashItem";

const ENTRY: TrashEntry = {
	id: "req_1",
	kind: "request",
	name: "List pets",
	deletedAt: 1700000000000,
	purgeCollections: 0,
	purgeRequests: 0,
};

beforeEach(() => cleanup());

describe("TrashItem icon buttons", () => {
	it.each([
		["Copy List pets for agent", "Copy for agent"],
		["Restore List pets", "Restore"],
		["Delete List pets forever", "Delete forever"],
	])("%s opens its tooltip on focus", async (name, tooltip) => {
		render(
			<TrashItem
				entry={ENTRY}
				onRestore={vi.fn()}
				onPurge={vi.fn()}
				isRestoring={false}
				isPurging={false}
			/>
		);
		const button = screen.getByRole("button", { name });
		expect(button).not.toHaveAttribute("title");

		await act(async () => {
			fireEvent.focus(button);
		});

		expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
	});
});

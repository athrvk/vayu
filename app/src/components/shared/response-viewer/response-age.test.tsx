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
 * A restored response has to look restored.
 *
 * The response pane has always been able to show a response that did not come
 * from the Send button - it rebuilds one from the last stored design run on
 * every cold start, and now also when a run is opened from history. Nothing
 * said so. The request editor beside it shows the request as it is *now*, so a
 * response from three days ago and one from three seconds ago rendered
 * identically, and there was no way to tell whether the two halves of the
 * screen described the same exchange.
 *
 * `ResponseState.timestamp` had been written for exactly this and read by
 * nothing - the defect this codebase repeats most often. It is now
 * `restoredFrom`, and this is its reader.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";

const HOUR_MS = 60 * 60 * 1000;

describe("the response age chip", () => {
	it("says how old the run is", () => {
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		render(<ResponseStatusBar status={200} statusText="OK" restoredFrom={{ at }} />);

		expect(screen.getByText(/from run - 2h ago/i)).toBeTruthy();
	});

	it("is absent for a response that was just executed", () => {
		// The common case. A chip on every response would say nothing.
		render(<ResponseStatusBar status={200} statusText="OK" time={12} size={11} />);

		expect(screen.queryByText(/from run/i)).toBeNull();
	});

	it("carries the exact time and the run id, which is where the old Run Details card went", () => {
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		const { container } = render(
			<ResponseStatusBar status={200} restoredFrom={{ at, runId: "run-abc" }} />
		);

		const chip = container.querySelector("[title]") as HTMLElement;
		expect(chip.title).toContain(new Date(at).toLocaleString());
		expect(chip.title).toContain("run-abc");
	});

	it("still renders without a run id, which the engine does not always store", () => {
		// `request_id` is optional engine-side, and so is the run a response was
		// restored from in some older rows.
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		const { container } = render(<ResponseStatusBar status={200} restoredFrom={{ at }} />);

		expect((container.querySelector("[title]") as HTMLElement).title).not.toContain("Run ");
	});

	it("paints no background, so it is not a Badge that would need variant=chip", () => {
		// Every Badge variant but `chip` pairs `bg-x` with `hover:bg-x/80`, and
		// tailwind-merge replaces the fill but not the hover - see
		// badge-hover.test.tsx. Nothing here is interactive.
		const at = new Date().toISOString();
		const { container } = render(<ResponseStatusBar status={200} restoredFrom={{ at }} />);

		const chip = container.querySelector("[title]") as HTMLElement;
		expect(chip.className).not.toMatch(/\bbg-/);
	});
});

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
 * The pane rebuilds the last stored design run on every cold start, and the
 * request editor beside it shows the request as it is now. A response from
 * three days ago and one from three seconds ago rendered identically, so there
 * was no way to tell whether the two halves of the screen described the same
 * exchange. `ResponseState.timestamp` was written for exactly this and read by
 * nothing.
 */

import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { formatInstant, resolveTimeZone } from "@/lib/time-value";
import { ResponseStatusBar } from "./ResponseStatusBar";

const HOUR_MS = 60 * 60 * 1000;

/** The age the chip prints, in whatever language the platform answers in. */
const relative = (at: string) => formatInstant(at, "relative");

/** Open the chip's card the way a keyboard user does, by focusing the time. */
async function openCard(container: HTMLElement) {
	fireEvent.focus(container.querySelector("time") as HTMLElement);
	return screen.findByTestId("time-hover-card");
}

describe("the response age chip", () => {
	it("says how old the run is", () => {
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		render(<ResponseStatusBar status={200} statusText="OK" restoredFrom={{ at }} />);

		expect(screen.getByText(/from run -/i).textContent).toBe(`from run - ${relative(at)}`);
	});

	it("is absent for a response that was just sent", () => {
		render(<ResponseStatusBar status={200} statusText="OK" time={12} size={11} />);

		expect(screen.queryByText(/from run/i)).toBeNull();
	});

	it("opens the time card with the zone, UTC and the run id", async () => {
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		const { container } = render(
			<ResponseStatusBar status={200} restoredFrom={{ at, runId: "run-abc" }} />
		);

		const card = await openCard(container);
		expect(card.textContent).toContain(resolveTimeZone());
		expect(card.textContent).toContain("UTC");
		expect(card.textContent).toContain("Restored from a stored run");
		expect(card.textContent).toContain("run-abc");
	});

	it("still opens the card without a run id, and names no run", async () => {
		const at = new Date(Date.now() - 2 * HOUR_MS).toISOString();
		const { container } = render(<ResponseStatusBar status={200} restoredFrom={{ at }} />);

		const card = await openCard(container);
		expect(card.textContent).toContain("Restored from a stored run");
		expect(card.textContent).not.toContain("Run");
	});

	it("paints no background, so it is not a Badge needing variant=chip", () => {
		// Every Badge variant but `chip` pairs bg-x with hover:bg-x/80, and
		// tailwind-merge replaces the fill but not the hover. Nothing here is
		// clickable. See badge-hover.test.tsx.
		const at = new Date().toISOString();
		const { container } = render(<ResponseStatusBar status={200} restoredFrom={{ at }} />);

		const chip = container.querySelector("time")?.closest("div") as HTMLElement;
		expect(chip.className).not.toMatch(/\bbg-/);
	});
});

/**
 * A *live* response has to look live, for the same reason a restored one has to
 * look restored.
 *
 * The pane sits open while you keep editing the request beside it, so a response
 * you sent twenty minutes and several edits ago reads exactly like one that just
 * came back. `time` beside it cannot answer this - that is how long the exchange
 * took, not when it happened.
 *
 * `ResponseState` carried a bare `timestamp` for this once and it was removed
 * for having one writer and no reader. This is the reader.
 */
describe("a live response's age", () => {
	it("shows how long ago it arrived", () => {
		const at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
		render(<ResponseStatusBar status={200} statusText="OK" time={12} receivedAt={at} />);
		expect(screen.getByText(relative(at))).toBeInTheDocument();
	});

	it("does not label it as coming from a run", () => {
		// "from run" belongs to the restored case and carries the run's identity.
		const at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
		render(<ResponseStatusBar status={200} statusText="OK" time={12} receivedAt={at} />);
		expect(screen.queryByText(/from run/i)).toBeNull();
	});

	it("lets the restored label win when a response is both", () => {
		// A restored response has no `receivedAt`, but if one ever carried both,
		// where it came from is the more specific fact.
		const at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
		render(
			<ResponseStatusBar
				status={200}
				statusText="OK"
				time={12}
				receivedAt={at}
				restoredFrom={{ at, runId: "run_1" }}
			/>
		);
		expect(screen.getByText(/from run/i)).toBeInTheDocument();
	});

	it("shows nothing when neither is set", () => {
		// A caller with no timestamp at all - the history viewer's stored rows.
		const { container } = render(<ResponseStatusBar status={200} statusText="OK" />);
		expect(container.textContent).not.toMatch(/ago/i);
	});
});

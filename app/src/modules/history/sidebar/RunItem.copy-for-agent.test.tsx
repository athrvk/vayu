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
 * "Copy for agent" on a history row (#2047).
 *
 * The row is handed the collection name its list resolved, and `runReference`
 * reduces the run's url to a path: a query string, even on a templated host
 * that does not parse, must not reach the clipboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import { formatInstant } from "@/lib/time-value";
import { useToastStore } from "@/stores";
import type { Run } from "@/types";

const SENTINEL = "s3cr3t-sentinel";
const START = 1_750_000_000_000;

function run(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: START,
		endTime: START + 3000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: `https://api.example.test/checkout?token=${SENTINEL}`,
			method: "POST",
		},
		...overrides,
	} as Run;
}

const noop = () => {};
const writeText = vi.fn();

beforeEach(() => {
	writeText.mockReset().mockResolvedValue(undefined);
	// jsdom ships no clipboard, and `useCopy` reports a rejection rather than
	// claiming a copy that did not happen - so the stub has to resolve.
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

async function copyForAgent(item: Run, collectionName?: string) {
	render(
		<RunItem
			run={item}
			onSelect={noop}
			onDelete={noop}
			isDeleting={false}
			collectionName={collectionName}
		/>
	);
	fireEvent.contextMenu(document.querySelector(`[${CONTEXT_ATTRIBUTE}="own-menu"]`)!);
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy for agent/ }));
	await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
	return writeText.mock.calls[0][0] as string;
}

describe("Copy for agent on a history row", () => {
	it("copies the run line with the url reduced to its path, and says so", async () => {
		const copied = await copyForAgent(run());

		expect(copied).toBe(
			`Vayu run "POST /checkout" (run_1) - design run, POST /checkout, ${formatInstant(START, "datetime")}, completed`
		);
		expect(copied).not.toContain(SENTINEL);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("names a collection run by the collection name its list resolved", async () => {
		const copied = await copyForAgent(
			run({
				type: "scenario",
				requestId: null,
				summary: { scenario: { collectionId: "col_1" } },
			} as Partial<Run>),
			"Acme API"
		);

		expect(copied).toContain('Vayu run "Acme API" (run_1)');
		expect(copied).toContain('collection "Acme API"');
	});

	it("keeps the query of a templated host off the clipboard too", async () => {
		const copied = await copyForAgent(
			run({
				summary: { url: `https://{{host}}/x?k=${SENTINEL}`, method: "GET" },
			} as Partial<Run>)
		);

		expect(copied).not.toContain(SENTINEL);
	});
});

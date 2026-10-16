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
 * "Compare with…" on a history row (#2164).
 *
 * A comparison needs a final load report and a saved request to find the other
 * runs by, so the entry is offered for exactly that and for nothing else: a
 * menu item that opened an empty compare view would be worse than no item.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import { CONTEXT_ATTRIBUTE } from "@/lib/context-menu";
import type { Run } from "@/types";

function run(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	} as Run;
}

const noop = () => {};
const row = () => document.querySelector<HTMLElement>(`[${CONTEXT_ATTRIBUTE}="own-menu"]`)!;

async function openMenu(item: Run, onCompare: ((id: string) => void) | null = noop) {
	render(
		<RunItem
			run={item}
			onSelect={noop}
			onDelete={noop}
			onCompare={onCompare ?? undefined}
			isDeleting={false}
		/>
	);
	fireEvent.contextMenu(row());
	await screen.findByRole("menu");
}

const compareItem = () => screen.queryByRole("menuitem", { name: "Compare with…" });

describe("a history row's Compare with… entry", () => {
	it("is offered for a finished load run of a saved request", async () => {
		await openMenu(run());

		expect(compareItem()).toBeInTheDocument();
	});

	it("is offered for a stopped load run too", async () => {
		await openMenu(run({ status: "stopped" }));

		expect(compareItem()).toBeInTheDocument();
	});

	it("is absent for a design run", async () => {
		await openMenu(run({ type: "design" }));

		expect(compareItem()).toBeNull();
	});

	it("is absent for a collection run", async () => {
		await openMenu(run({ type: "scenario", requestId: null }));

		expect(compareItem()).toBeNull();
	});

	it("is absent for a run of an unsaved request", async () => {
		await openMenu(run({ requestId: null }));

		expect(compareItem()).toBeNull();
	});

	it("is absent for a run still executing, which has no final report", async () => {
		await openMenu(run({ status: "running" }));

		expect(compareItem()).toBeNull();
	});

	it("is absent where the list gives the row no handler", async () => {
		await openMenu(run(), null);

		expect(compareItem()).toBeNull();
	});

	it("hands the run to the handler", async () => {
		const onCompare = vi.fn();
		await openMenu(run(), onCompare);

		fireEvent.click(compareItem()!);

		await waitFor(() => expect(onCompare).toHaveBeenCalledWith("run_1"));
	});
});

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * A run type the renderer was not written for must render, not crash.
 *
 * The engine gained a third `runs.type` - `scenario`, a collection run - before
 * the app gained any UI for one (that is a later phase). Every branch in this
 * row is `run.type === "load"`, so a scenario row takes the non-load path; what
 * this pins is that the row still renders its identity and stays clickable,
 * rather than the list dying on an unknown value.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function run(type: Run["type"]): Run {
	return {
		id: "run_1",
		type,
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/checkout",
			method: "POST",
		},
	} as Run;
}

const noop = () => {};

describe("RunItem run types", () => {
	it("renders a scenario run row", () => {
		render(
			<RunItem run={run("scenario")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);

		expect(screen.getByText("https://api.example.test/checkout")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Open .* run, completed/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Delete run" })).toBeInTheDocument();
	});

	it("keeps the load-run affordances to load runs", () => {
		const { container } = render(
			<RunItem run={run("scenario")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);
		const scenarioIcons = container.querySelectorAll("svg").length;

		const loadRender = render(
			<RunItem run={run("load")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);
		const loadIcons = loadRender.container.querySelectorAll("svg").length;

		// The load badge is one of them, so the counts must differ - a row that
		// rendered identically would mean the type branch had stopped mattering
		// and this test would pass while proving nothing.
		expect(loadIcons).toBeGreaterThan(scenarioIcons);
	});
});

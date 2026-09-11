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
 * A proper request name over a raw URL, on the history row.
 *
 * `RunSummary.requestName` is the request's name as the client sent it at run
 * start - never re-read from the requests table - so the row shows it when it
 * is present and worth showing, and falls back to the url otherwise: absent
 * (a run recorded before this field existed, or a run whose client omitted
 * it), or still the default name every new request starts with.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import type { Run } from "@/types";

function loadRun(overrides: Partial<Run> = {}): Run {
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

describe("RunItem request name", () => {
	it("shows the request's name in place of the url when the run recorded one", () => {
		render(
			<RunItem
				run={loadRun({
					summary: {
						url: "https://api.example.test/checkout",
						method: "POST",
						requestName: "Checkout",
					},
				})}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(screen.getByText("Checkout")).toBeInTheDocument();
		expect(screen.queryByText("https://api.example.test/checkout")).not.toBeInTheDocument();
	});

	it("falls back to the url when the run recorded no name", () => {
		render(
			<RunItem
				run={loadRun({
					summary: { url: "https://api.example.test/checkout", method: "POST" },
				})}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(screen.getByText("https://api.example.test/checkout")).toBeInTheDocument();
	});

	it("falls back to the url when the recorded name is still the default", () => {
		render(
			<RunItem
				run={loadRun({
					summary: {
						url: "https://api.example.test/checkout",
						method: "POST",
						requestName: DEFAULT_REQUEST_NAME,
					},
				})}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(screen.getByText("https://api.example.test/checkout")).toBeInTheDocument();
		expect(screen.queryByText(DEFAULT_REQUEST_NAME)).not.toBeInTheDocument();
	});

	it("names the run by its request name in the accessible name too", () => {
		render(
			<RunItem
				run={loadRun({
					summary: {
						url: "https://api.example.test/checkout",
						method: "POST",
						requestName: "Checkout",
					},
				})}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(
			screen.getByRole("button", { name: /Open load test run, completed, Checkout/ })
		).toBeInTheDocument();
	});
});

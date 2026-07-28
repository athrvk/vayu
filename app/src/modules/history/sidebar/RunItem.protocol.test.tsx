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
 * The protocol shown on a load-run sidebar row - fed by the compact list-row
 * `summary` (`GET /runs`), which carries the requested protocol, never the
 * negotiated one.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RunItem from "./RunItem";
import type { Run } from "@/types";
import type { HttpVersion } from "@/constants/request";

function loadRun(httpVersion: HttpVersion | undefined): Run {
	return {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/users",
			method: "GET",
			mode: "constant_rps",
			duration: "3s",
			concurrency: 20,
			httpVersion,
		},
	} as Run;
}

const noop = () => {};

describe("RunItem protocol", () => {
	it("shows the requested protocol's label on a load run row", () => {
		render(
			<RunItem run={loadRun("http2")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);

		expect(screen.getByText("HTTP/2")).toBeInTheDocument();
	});

	it("labels a run that requested auto negotiation as Auto, not blank", () => {
		render(
			<RunItem run={loadRun("auto")} onSelect={noop} onDelete={vi.fn()} isDeleting={false} />
		);

		expect(screen.getByText("Auto")).toBeInTheDocument();
	});

	it("shows no protocol label when the summary carries none", () => {
		render(
			<RunItem
				run={loadRun(undefined)}
				onSelect={noop}
				onDelete={vi.fn()}
				isDeleting={false}
			/>
		);

		expect(screen.queryByText("Auto")).not.toBeInTheDocument();
		expect(screen.queryByText("HTTP/2")).not.toBeInTheDocument();
		expect(screen.queryByText("HTTP/1.x")).not.toBeInTheDocument();
	});
});

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
 * Issue #1503: a load run that sent every request with an unresolved
 * `{{token}}`, or skipped a pre-request script, still finishes and still
 * reads green everywhere else in the report. Mutation check: drop the
 * `warnings.length === 0` guard and the "says nothing" case fails; drop the
 * component from OverviewTab and its own rendering test fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunWarnings } from "./RunWarnings";

describe("RunWarnings", () => {
	it.each([{ warnings: undefined }, { warnings: [] }])(
		"says nothing when the warnings are $warnings",
		({ warnings }) => {
			const { container } = render(<RunWarnings warnings={warnings} />);
			expect(container.firstChild).toBeNull();
		}
	);

	it("names the unresolved variables and the affected request count", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "unresolved_tokens",
						message: "2 requests sent with unresolved variables: token",
						count: 2,
						names: ["token"],
					},
				]}
			/>
		);
		expect(screen.getByText("Unresolved variables were sent")).toBeTruthy();
		expect(screen.getByText(/2 requests sent with unresolved variables: token/)).toBeTruthy();
	});

	it("reports a skipped pre-request script", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "pre_request_script_skipped",
						message: "1 step carries a pre-request script that does not run under load",
						steps: 1,
					},
				]}
			/>
		);
		expect(screen.getByText("Pre-request script won't run")).toBeTruthy();
	});

	// Mutation check: drop the per_host_limit_raised title and this reads the
	// generic "did not do everything it was asked", which this run did.
	it("reports a raised per-host connection limit under its own title", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "per_host_limit_raised",
						message:
							"Connections per host raised from 200 to 500 per worker to cover this run's virtual users",
						configured: 200,
						effective: 500,
					},
				]}
			/>
		);
		expect(screen.getByText("Connections per host were raised")).toBeTruthy();
		expect(screen.queryByText("This run did not do everything it was asked")).toBeNull();
	});

	// Mutation check: drop the connection_replayed title and this reads the
	// generic "did not do everything it was asked", which this run did.
	it("reports re-sent requests under a title that does not say the run failed", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "connection_replayed",
						message:
							"3 requests were re-sent on a new connection after the server dropped or refused a reused one.",
						count: 3,
					},
				]}
			/>
		);
		expect(
			screen.getByText("Some requests were re-sent after a dropped connection")
		).toBeTruthy();
		expect(screen.getByText(/3 requests were re-sent on a new connection/)).toBeTruthy();
		expect(screen.queryByText("This run did not do everything it was asked")).toBeNull();
	});

	// Mutation check: drop the cookies_dropped title and this reads the generic
	// "did not do everything it was asked", which this run did.
	it("reports dropped Set-Cookie headers under their own title, with the engine's count", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "cookies_dropped",
						message:
							"3 Set-Cookie headers were dropped across the run by libcurl's cookie engine",
						count: 3,
					},
				]}
			/>
		);
		expect(screen.getByText("Some cookies the server set were dropped")).toBeTruthy();
		expect(screen.getByText(/3 Set-Cookie headers were dropped across the run/)).toBeTruthy();
		expect(screen.queryByText("This run did not do everything it was asked")).toBeNull();
	});

	// Mutation check: drop the think_timer_skipped_open_loop title and this reads
	// the generic "did not do everything it was asked", which this run did.
	it("reports a skipped think timer under its own title", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "think_timer_skipped_open_loop",
						message:
							"A think timer does not apply to a constant-rate run: requests are sent on a schedule, not one after another",
						timers: 1,
					},
				]}
			/>
		);
		expect(screen.getByText("Think timer skipped on a constant-rate run")).toBeTruthy();
		expect(screen.queryByText("This run did not do everything it was asked")).toBeNull();
	});

	// Mutation check: drop a #3782 title and its row reads the generic "did not
	// do everything it was asked", which a throttled-but-complete run did.
	it.each([
		{
			code: "rate_limited_dominant",
			title: "Most responses were rate limited",
			message:
				"9 of 10 responses were 429 Too Many Requests. Set retryAfterBackoff to back off.",
			count: 9,
		},
		{
			code: "retry_after_backoff",
			title: "Virtual users waited out Retry-After",
			message: "4 responses asked for a Retry-After wait, and each was waited out.",
			count: 4,
		},
		{
			code: "retry_after_skipped_open_loop",
			title: "Retry-After back-off skipped on a constant-rate run",
			message: "Retry-After back-off does not apply to a constant-rate run",
			count: undefined,
		},
	])("titles $code for what the run did, not as a failure", ({ code, title, message, count }) => {
		const { container } = render(<RunWarnings warnings={[{ code, message, count }]} />);
		expect(screen.getByText(title)).toBeTruthy();
		expect(container.textContent).toContain(message);
		expect(screen.queryByText("This run did not do everything it was asked")).toBeNull();
	});

	it("renders one callout per warning when a run carries both", () => {
		render(
			<RunWarnings
				warnings={[
					{
						code: "unresolved_tokens",
						message: "1 request sent with an unresolved variable: token",
						count: 1,
						names: ["token"],
					},
					{
						code: "pre_request_script_skipped",
						message: "1 step carries a pre-request script that does not run under load",
						steps: 1,
					},
				]}
			/>
		);
		expect(screen.getByText("Unresolved variables were sent")).toBeTruthy();
		expect(screen.getByText("Pre-request script won't run")).toBeTruthy();
	});
});

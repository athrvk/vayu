/**
 * @vitest-environment jsdom
 *
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache License, Version 2.0
 * found in the LICENSE file in the "app" directory of this source tree.
 */

/**
 * A proxy failure is recognisably a proxy failure in both funnels (issue #708).
 *
 * Phase 1 (#705) made `ProxyError` distinct on the wire; nothing rendered it
 * distinctly, so a corporate user still read "Could not get a response" and
 * went to debug an endpoint that was never reached. This pins the two halves of
 * the fix together, because either alone is worthless:
 *
 * 1. Both funnels have to deliver the engine's code. `execute-mapping.ts` and
 *    `restore-response.ts` are a copy pair and a field present in one has gone
 *    missing from the other before (`validation-funnels.test.ts`,
 *    `client-certificate-funnels.test.ts`).
 * 2. The pane has to say something different when it arrives. A code carried
 *    faithfully into a view that renders every failure identically is the same
 *    bug one layer up.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { SanityResult } from "@/types";
import ClientErrorView from "../components/ResponseViewer/ClientErrorView";
import { responseFromExecuteResult } from "./execute-mapping";
import { responseFromRunResult, type RunResultSample } from "./restore-response";

/** curl's own words for a proxy that could not be resolved. */
const DETAIL = "Could not resolve proxy: corp-proxy.example";

/** A live `/execute` body for a transfer that failed at the proxy hop. */
const executeResult = (): SanityResult =>
	({
		status: 0,
		statusText: "Error",
		headers: {},
		body: "",
		bodyRaw: "",
		bodySize: 0,
		errorCode: "PROXY_ERROR",
		errorMessage: DETAIL,
	}) as unknown as SanityResult;

/** The same failure as History replays it: a trace with no `response` node. */
const runResult = (): RunResultSample =>
	({
		timestamp: 1_700_000_000_000,
		statusCode: 0,
		statusText: "Error",
		latencyMs: 4,
		trace: {
			request: { method: "GET", url: "https://api.example.com/pets", headers: {} },
			error_type: "PROXY_ERROR",
			error_message: DETAIL,
		},
	}) as unknown as RunResultSample;

describe("the two response funnels", () => {
	it("both carry the engine's proxy error code and message", () => {
		const live = responseFromExecuteResult(executeResult());
		const restored = responseFromRunResult(runResult());

		expect(live.errorCode).toBe("PROXY_ERROR");
		expect(restored?.errorCode).toBe("PROXY_ERROR");
		expect(live.errorMessage).toBe(DETAIL);
		expect(restored?.errorMessage).toBe(DETAIL);
	});
});

describe("the response pane", () => {
	it("names the proxy as the hop that failed, and the setting to fix", () => {
		render(<ClientErrorView errorCode="PROXY_ERROR" errorMessage={DETAIL} />);

		// The heading, because it is the one line a reader is guaranteed to see.
		expect(screen.getByText("Could not reach the proxy")).toBeInTheDocument();
		// And a hint that points at the setting rather than restating the error.
		expect(screen.getByText(/Network & connectivity > Proxy/)).toBeInTheDocument();
	});

	it("does not read as a proxy failure when it was not one", () => {
		// The half that gives the assertion above its meaning: with the
		// PROXY_ERROR entries removed, this is what every failure would look
		// like, and the test above would still pass on a shared heading.
		render(<ClientErrorView errorCode="CONNECTION_FAILED" errorMessage="Connection refused" />);

		expect(screen.getByText("Could not get a response")).toBeInTheDocument();
		expect(screen.queryByText(/Network & connectivity > Proxy/)).not.toBeInTheDocument();
	});

	it("names both legitimate outs for a verification failure", () => {
		// A user whose certificate was refused has exactly two honest choices,
		// and neither is discoverable from libcurl's message. Both are named.
		render(<ClientErrorView errorCode="SSL_ERROR" errorMessage="unable to get local issuer" />);

		expect(screen.getByText(/Custom CA Certificates/)).toBeInTheDocument();
		expect(screen.getByText(/Verify SSL/)).toBeInTheDocument();
	});
});

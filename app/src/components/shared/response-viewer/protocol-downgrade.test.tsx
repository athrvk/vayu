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
 * A protocol downgrade has to be visible, and only when it happened.
 *
 * Asking for HTTP/2 and getting HTTP/1.1 produced a 200, a latency and a size -
 * exactly what success produces. Three releases shipped with every Windows
 * request downgraded that way and nothing anywhere in the UI moved (issue
 * #215). The engine decides whether it happened; the only thing that can go
 * wrong on this side is the bar not drawing it, or drawing it on a response
 * that got what it asked for - so both directions are asserted, plus the
 * mapping that carries the engine's answer this far.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResponseStatusBar } from "./ResponseStatusBar";
import { responseFromExecuteResult } from "@/modules/request-builder/utils/execute-mapping";
import type { SanityResult } from "@/types";

const executeResult = (over: Partial<SanityResult> = {}): SanityResult =>
	({
		status: 200,
		statusText: "OK",
		headers: {},
		body: null,
		bodyRaw: "",
		bodySize: 0,
		timing: { totalMs: 5 },
		...over,
	}) as SanityResult;

describe("the protocol-downgrade warning", () => {
	it("names the protocol that was actually used", () => {
		render(
			<ResponseStatusBar
				status={200}
				statusText="OK"
				time={12}
				size={11}
				httpVersion="HTTP/1.1"
				httpVersionDowngraded
			/>
		);

		expect(screen.getByText(/HTTP\/1\.1, not HTTP\/2/i)).toBeTruthy();
	});

	it("is absent when the connection negotiated HTTP/2", () => {
		render(
			<ResponseStatusBar
				status={200}
				statusText="OK"
				time={12}
				size={11}
				httpVersion="HTTP/2"
			/>
		);

		expect(screen.queryByText(/not HTTP\/2/i)).toBeNull();
	});

	it("is absent for an ordinary HTTP/1.1 response nobody asked to upgrade", () => {
		// The bar must not infer a downgrade from the protocol alone. Only the
		// engine knows what was requested, and `auto` promises nothing.
		render(
			<ResponseStatusBar
				status={200}
				statusText="OK"
				time={12}
				size={11}
				httpVersion="HTTP/1.1"
			/>
		);

		expect(screen.queryByText(/not HTTP\/2/i)).toBeNull();
	});

	it("survives the execute-result mapping", () => {
		// The flag is useless if it is dropped between the engine's JSON and
		// `ResponseState` - the "written but never read" failure this codebase
		// keeps rediscovering, pointed the other way.
		const mapped = responseFromExecuteResult(
			executeResult({ httpVersion: "HTTP/1.1", httpVersionDowngraded: true })
		);

		expect(mapped.httpVersionDowngraded).toBe(true);
		expect(mapped.httpVersion).toBe("HTTP/1.1");
	});

	it("stays false through the mapping when the engine reports no downgrade", () => {
		const mapped = responseFromExecuteResult(
			executeResult({ httpVersion: "HTTP/2", httpVersionDowngraded: false })
		);

		expect(mapped.httpVersionDowngraded).toBe(false);
	});
});

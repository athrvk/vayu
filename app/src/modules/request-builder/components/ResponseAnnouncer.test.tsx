/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What these tests can and cannot show.
 *
 * They assert that the live region exists before there is anything to announce,
 * that its text is what we want spoken, and that a second identical response
 * still mutates the DOM. jsdom speaks nothing, so none of this proves a screen
 * reader announces — it proves the preconditions for announcement hold, which
 * is where the Toaster's original bug lived.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../context/RequestBuilderContext";
import type { RequestBuilderContextValue, ResponseState } from "../types";
import ResponseAnnouncer from "./ResponseAnnouncer";

function makeResponse(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body: "",
		bodyType: "json",
		size: 1024,
		time: 340,
		...overrides,
	};
}

// The announcer reads exactly two members off the context. Building a whole
// provider would couple this test to every unrelated field the builder grows.
function renderWith(value: { response: ResponseState | null; isExecuting: boolean }) {
	return render(
		<RequestBuilderContext.Provider value={value as unknown as RequestBuilderContextValue}>
			<ResponseAnnouncer />
		</RequestBuilderContext.Provider>
	);
}

describe("ResponseAnnouncer", () => {
	it("is in the DOM before there is anything to announce", () => {
		// The Toaster bug: a live region that mounts together with its first
		// message is commonly not announced at all.
		renderWith({ response: null, isExecuting: false });
		const region = screen.getByRole("status");
		expect(region).toBeInTheDocument();
		expect(region).toHaveTextContent("");
	});

	it("carries polite, atomic live semantics", () => {
		renderWith({ response: null, isExecuting: false });
		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region).toHaveAttribute("aria-atomic", "true");
	});

	it("announces status and a spoken-friendly duration", () => {
		renderWith({ response: makeResponse(), isExecuting: false });
		expect(screen.getByRole("status")).toHaveTextContent("Response 200 OK, 340 milliseconds");
	});

	it("speaks seconds rather than four-figure milliseconds", () => {
		renderWith({ response: makeResponse({ time: 2400 }), isExecuting: false });
		expect(screen.getByRole("status")).toHaveTextContent("2.4 seconds");
	});

	it("reports a client-side failure by its message, not as status 0", () => {
		renderWith({
			response: makeResponse({
				status: 0,
				statusText: "",
				errorMessage: "Could not resolve host",
			}),
			isExecuting: false,
		});
		const text = screen.getByRole("status").textContent ?? "";
		expect(text).toContain("Request failed. Could not resolve host");
		expect(text).not.toContain("0 ");
	});

	it("summarises test results when the request ran tests", () => {
		renderWith({
			response: makeResponse({
				testResults: [
					{ name: "a", passed: true },
					{ name: "b", passed: false },
				],
			}),
			isExecuting: false,
		});
		expect(screen.getByRole("status")).toHaveTextContent("1 of 2 tests failed");
	});

	it("acknowledges the send, since Ctrl+Enter moves focus nowhere", () => {
		renderWith({ response: null, isExecuting: true });
		expect(screen.getByRole("status")).toHaveTextContent("Sending request");
	});

	it("replaces the text node when a second response repeats the first", () => {
		// Byte-identical text means React leaves the DOM alone and the second
		// response is announced as nothing. The key bump is what prevents that.
		const { rerender } = renderWith({ response: makeResponse(), isExecuting: false });
		const first = screen.getByRole("status").firstElementChild;

		rerender(
			<RequestBuilderContext.Provider
				value={
					{
						response: makeResponse(),
						isExecuting: false,
					} as unknown as RequestBuilderContextValue
				}
			>
				<ResponseAnnouncer />
			</RequestBuilderContext.Provider>
		);

		const second = screen.getByRole("status").firstElementChild;
		expect(second).not.toBe(first);
		expect(screen.getByRole("status")).toHaveTextContent("Response 200 OK, 340 milliseconds");
	});
});

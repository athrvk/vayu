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
 * The Raw tab used to print `HTTP/1.1` on the response status line no matter
 * what actually negotiated - the last hardcoded protocol claim in the app
 * (Task 14). This renders the component the way `ResponseViewer` does and
 * asserts the negotiated protocol - not a hardcoded guess - is what shows.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RawRequestResponse from "./RawRequestResponse";

// Monaco does not run under jsdom - render the raw text plainly so the
// assertions below check real content, not an empty editor shell.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="raw-content">{value}</div>,
}));

function response(overrides: Partial<Parameters<typeof RawRequestResponse>[0]["response"]> = {}) {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/plain" },
		body: "hi",
		...overrides,
	};
}

describe("RawRequestResponse", () => {
	it("shows the negotiated protocol on the status line, not a hardcoded one", () => {
		render(<RawRequestResponse rawRequest="" response={response({ httpVersion: "HTTP/2" })} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/2 200 OK");
	});

	it("falls back to HTTP/1.1 when no protocol was negotiated at all", () => {
		render(<RawRequestResponse rawRequest="" response={response({ httpVersion: "" })} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/1.1 200 OK");
	});

	it("defaults to HTTP/1.1 when the response carries no httpVersion field", () => {
		render(<RawRequestResponse rawRequest="" response={response()} />);

		expect(screen.getByTestId("raw-content").textContent).toContain("HTTP/1.1 200 OK");
	});
});

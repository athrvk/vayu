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
 * The Headers tab variant of the headers family.
 *
 * It had no test at all, which is worth fixing on the way past rather than
 * after: the empty state below is the one behaviour that is this panel's own
 * rather than `HeadersViewer`'s, and it is the behaviour a copy of this panel
 * has already lost once - `HeadersViewer` returns `null` with no entries, so
 * without the fallback a response carrying no headers renders a blank pane with
 * nothing saying why. Delete the fallback and the third case here fails.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ResponseHeadersPanel } from "./HeadersViewer";

describe("ResponseHeadersPanel", () => {
	it("opens the response headers and collapses the request headers", () => {
		render(
			<ResponseHeadersPanel
				requestHeaders={{ accept: "application/json" }}
				responseHeaders={{ "content-type": "application/json" }}
			/>
		);

		// Both sections are present...
		expect(screen.getByText("Response Headers")).toBeInTheDocument();
		expect(screen.getByText("Request Headers")).toBeInTheDocument();

		// ...but only the response one has its table open. What came back is the
		// question being asked; what was sent usually is not.
		expect(screen.getByText("content-type")).toBeInTheDocument();
		expect(screen.queryByText("accept")).toBeNull();
	});

	it("omits the request section entirely when nothing was sent", () => {
		render(<ResponseHeadersPanel responseHeaders={{ "content-type": "text/plain" }} />);

		expect(screen.queryByText("Request Headers")).toBeNull();
		expect(screen.getByText("Response Headers")).toBeInTheDocument();
	});

	it("explains an empty response rather than rendering a blank pane", () => {
		render(<ResponseHeadersPanel responseHeaders={{}} />);

		expect(screen.getByText("No headers in response")).toBeInTheDocument();
	});

	it("shows no empty state once headers came back", () => {
		render(<ResponseHeadersPanel responseHeaders={{ server: "nginx" }} />);

		expect(screen.queryByText("No headers in response")).toBeNull();
		expect(screen.getByText("nginx")).toBeInTheDocument();
	});
});

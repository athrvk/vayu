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
import { fireEvent, render, screen } from "@testing-library/react";

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
		expect(screen.getByText("Response headers")).toBeInTheDocument();
		expect(screen.getByText("Request headers")).toBeInTheDocument();

		// ...but only the response one has its table open. What came back is the
		// question being asked; what was sent usually is not.
		expect(screen.getByText("content-type")).toBeInTheDocument();
		expect(screen.queryByText("accept")).toBeNull();
	});

	it("omits the request section entirely when nothing was sent", () => {
		render(<ResponseHeadersPanel responseHeaders={{ "content-type": "text/plain" }} />);

		expect(screen.queryByText("Request headers")).toBeNull();
		expect(screen.getByText("Response headers")).toBeInTheDocument();
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

describe("ResponseHeadersPanel, the request as sent (issue #2464)", () => {
	const wire: [string, string][] = [
		["Host", "api.example.com"],
		["Accept", "*/*"],
		["accept", "text/plain"],
		["Content-Length", "5"],
	];

	it("lists the wire lines in the one request section, in order, repeats included", () => {
		render(
			<ResponseHeadersPanel
				requestHeaders={{ accept: "application/json" }}
				wireRequestHeaders={wire}
				responseHeaders={{ server: "nginx" }}
			/>
		);

		// One section, titled as before: no second group for the transport's lines.
		const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		expect(titles).toEqual(["Request headers", "Response headers"]);

		// Collapsed like the sent record was: the response is the question.
		expect(screen.queryByText("Host")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /request headers/i }));

		const rows = screen.getAllByRole("row").map((row) => row.firstElementChild?.textContent);
		expect(rows.slice(0, 5)).toEqual(["Name", "Host", "Accept", "accept", "Content-Length"]);
	});

	it("counts the wire lines in the section's badge", () => {
		render(
			<ResponseHeadersPanel
				requestHeaders={{ accept: "x" }}
				wireRequestHeaders={wire}
				responseHeaders={{}}
			/>
		);

		expect(screen.getByRole("button", { name: /request headers/i })).toHaveTextContent("4");
	});

	it("falls back to the sent record when there are no wire lines", () => {
		const { rerender } = render(
			<ResponseHeadersPanel requestHeaders={{ "x-mine": "1" }} responseHeaders={{ a: "b" }} />
		);
		fireEvent.click(screen.getByRole("button", { name: /request headers/i }));
		expect(screen.getByText("x-mine")).toBeInTheDocument();

		rerender(
			<ResponseHeadersPanel
				requestHeaders={{ "x-mine": "1" }}
				wireRequestHeaders={[]}
				responseHeaders={{ a: "b" }}
			/>
		);
		expect(screen.getByText("x-mine")).toBeInTheDocument();
	});

	it("shows the wire lines without a sent record", () => {
		render(
			<ResponseHeadersPanel
				wireRequestHeaders={[["Host", "a.test"]]}
				responseHeaders={{ server: "nginx" }}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: /request headers/i }));
		expect(screen.getByText("a.test")).toBeInTheDocument();
	});

	it("names nothing of the transport in the pane", () => {
		const { container } = render(
			<ResponseHeadersPanel
				requestHeaders={{ accept: "x" }}
				wireRequestHeaders={wire}
				responseHeaders={{ server: "nginx" }}
			/>
		);

		expect(container.textContent?.toLowerCase()).not.toContain("libcurl");
	});
});

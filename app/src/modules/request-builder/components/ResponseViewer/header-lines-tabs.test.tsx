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
 * The response pane's Headers, Cookies and Raw tabs read the header lines as
 * received, not the folded map (issue #2460).
 *
 * The folded map lowercases every name and joins a repeated one into a single
 * entry, so three tabs that each rebuilt the headers from it showed one
 * `Set-Cookie` row where the server sent two, and a cookie value holding a comma
 * as two cookies. Each case renders the whole pane, so it fails on a tab that
 * is wired to `shown.headers` whatever the component below it does.
 *
 * Mutation checks: pass `headers` to `ResponseCookies` alone and the Cookies
 * case fails; hand `RawRequestResponse` the map and the Raw case fails; count
 * `Object.keys(shown.headers)` for the tab and the count case fails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

// Monaco does not run under jsdom; the Raw tab's text is the assertion.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="editor">{value}</div>,
}));

const state: { response: ResponseState | null; isExecuting: boolean; request: { id: null } } = {
	response: null,
	isExecuting: false,
	request: { id: null },
};
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const LINES = [
	{ name: "Content-Type", value: "text/plain" },
	{ name: "X-Dup", value: "one" },
	{ name: "x-dup", value: "two" },
	{ name: "Set-Cookie", value: "a=1; Path=/" },
	{ name: "Set-Cookie", value: "prefs=a=1, theme=dark; Path=/" },
];

const FOLDED = {
	"content-type": "text/plain",
	"x-dup": "one, two",
	"set-cookie": "a=1; Path=/, prefs=a=1, theme=dark; Path=/",
};

function response(overrides: Partial<ResponseState> = {}): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: FOLDED,
		headerLines: LINES,
		body: "hi",
		bodyRaw: "hi",
		bodyType: "text",
		size: 2,
		time: 5,
		...overrides,
	};
}

function renderViewer(shown: ResponseState) {
	state.response = shown;
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

function selectTab(name: RegExp) {
	const trigger = screen.getByRole("tab", { name });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

const bodyRows = (container: HTMLElement) =>
	Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
		Array.from(tr.querySelectorAll("td")).map((td) => td.textContent)
	);

describe("fixture guard", () => {
	it("holds more lines than the folded map has names", () => {
		expect(LINES.length).toBeGreaterThan(Object.keys(FOLDED).length);
	});
});

describe("the Headers tab", () => {
	it("counts the lines, not the folded names", () => {
		renderViewer(response());

		const count = screen
			.getByRole("tab", { name: /headers/i })
			.querySelector('[data-slot="tab-count"]');
		expect(count?.textContent).toBe(String(LINES.length));
	});

	it("counts the folded names for a response with no lines", () => {
		renderViewer(response({ headerLines: undefined }));

		const count = screen
			.getByRole("tab", { name: /headers/i })
			.querySelector('[data-slot="tab-count"]');
		expect(count?.textContent).toBe(String(Object.keys(FOLDED).length));
	});

	it("lists a repeated header once per line in the received case", () => {
		const { container } = renderViewer(response());
		selectTab(/headers/i);

		expect(bodyRows(container)).toEqual(LINES.map((l) => [l.name, l.value]));
	});
});

describe("the Cookies tab", () => {
	it("shows a cookie per Set-Cookie line, a comma in a value kept whole", () => {
		const { container } = renderViewer(response());
		selectTab(/cookies/i);

		expect(bodyRows(container).map((row) => row[0])).toEqual(["a", "prefs"]);
		expect(container.textContent).toContain("a=1, theme=dark");
	});

	it("falls back to splitting the folded header when there are no lines", () => {
		const { container } = renderViewer(response({ headerLines: undefined }));
		selectTab(/cookies/i);

		expect(bodyRows(container).map((row) => row[0])).toEqual(["a", "prefs", "theme"]);
	});
});

describe("the Raw tab", () => {
	it("prints every line as received, one per header", () => {
		renderViewer(response());
		selectTab(/raw/i);

		const text = screen.getByTestId("editor").textContent ?? "";
		for (const { name, value } of LINES) {
			expect(text).toContain(`< ${name}: ${value}`);
		}
		expect(text.match(/< Set-Cookie: /g)).toHaveLength(2);
		expect(text).not.toContain("< x-dup: one, two");
	});
});

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
 * The Console draws each `pm.sendRequest` a script made as an expandable row
 * (#3633): in its summary line's place, or after its script's last line when
 * no line names it, and found by the filter like any line.
 *
 * Mutation check: drop the records from the empty-state test in
 * `ConsoleOutput` (`logs.length === 0`) and the console-off case reads
 * "No console output"; drop `scriptRequests` from the call to `consoleRows`
 * and every case here fails.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));

import type { ConsoleLogEntry, ScriptRequestRecord } from "@/types";
import { TooltipProvider } from "@/components/ui";
import ConsoleOutput from "./ConsoleOutput";

/** The timing tiles' info chips are tooltips; the app's root provides one. */
const render = (ui: ReactNode) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const TOKEN_CALL: ScriptRequestRecord = {
	source: "pre",
	scope: "collection",
	startedAt: 1_763_452_800_123,
	status: 200,
	statusText: "OK",
	request: {
		method: "POST",
		url: "https://auth.example.test/token",
		headers: { Authorization: "<redacted>" },
		sentHeaders: { Authorization: "<redacted>", "Content-Type": "text/plain" },
		sentHeaderLines: [
			{ name: "Authorization", value: "<redacted>" },
			{ name: "Content-Type", value: "text/plain" },
		],
		body: "grant_type=client_credentials",
	},
	response: {
		headers: { "content-type": "text/plain" },
		headerLines: [{ name: "X-Token-Server", value: "local" }],
		body: "tok_123",
		bodyBytes: 7,
	},
	totalMs: 41.2,
	dnsMs: 0,
	connectMs: 0.4,
	firstByteMs: 38.9,
	downloadMs: 1.1,
};

const REFUSED_CALL: ScriptRequestRecord = {
	source: "pre",
	status: 0,
	statusText: "Error",
	request: { method: "GET", url: "http://127.0.0.1:1/down" },
	error_type: "CONNECTION_FAILED",
	error_message: "Connection refused",
	totalMs: 0.4,
};

const SUMMARY: ConsoleLogEntry = {
	source: "pre",
	scope: "collection",
	level: "info",
	message: "pm.sendRequest POST https://auth.example.test/token -> 200 (41 ms)",
	scriptRequest: 0,
};

const tokenRow = () => screen.getByRole("button", { name: /POST.*auth\.example\.test\/token/ });

/** Whether `a` comes before `b` in the document. */
const precedes = (a: Node, b: Node) =>
	Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("a script request in the Console", () => {
	it("stands in the summary line's place, among the script's other lines", () => {
		render(
			<ConsoleOutput
				logs={[
					{ source: "pre", scope: "collection", level: "log", message: "before" },
					SUMMARY,
					{ source: "pre", scope: "collection", level: "log", message: "after" },
				]}
				scriptRequests={[TOKEN_CALL]}
				errors={{}}
			/>
		);

		expect(screen.queryByText(SUMMARY.message)).toBeNull();
		expect(precedes(screen.getByText("before"), tokenRow())).toBe(true);
		expect(precedes(tokenRow(), screen.getByText("after"))).toBe(true);
		expect(tokenRow()).toHaveTextContent("200 OK");
		expect(tokenRow()).toHaveTextContent("41ms");
	});

	it("expands to the request and response headers and bodies, and the timing", () => {
		render(<ConsoleOutput logs={[SUMMARY]} scriptRequests={[TOKEN_CALL]} errors={{}} />);

		expect(tokenRow()).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(tokenRow());
		expect(tokenRow()).toHaveAttribute("aria-expanded", "true");

		expect(screen.getByText("Request headers")).toBeInTheDocument();
		expect(screen.getByText("Response headers")).toBeInTheDocument();
		// The sent lines in wire order, masked as the engine wrote them.
		expect(screen.getAllByText("<redacted>")).toHaveLength(1);
		expect(screen.getByText("X-Token-Server:")).toBeInTheDocument();
		const bodies = screen.getAllByTestId("code-editor").map((el) => el.textContent);
		expect(bodies).toEqual(["grant_type=client_credentials", "tok_123"]);
		expect(screen.getByText("Timing")).toBeInTheDocument();
	});

	it("draws a call no line names after the script's last line", () => {
		render(
			<ConsoleOutput
				logs={[
					{ source: "pre", level: "log", message: "pre line" },
					{ source: "test", level: "log", message: "test line" },
				]}
				scriptRequests={[REFUSED_CALL]}
				errors={{}}
			/>
		);

		const row = screen.getByRole("button", { name: /GET.*127\.0\.0\.1/ });
		expect(precedes(screen.getByText("pre line"), row)).toBe(true);
		expect(precedes(row, screen.getByText("test line"))).toBe(true);
	});

	it("shows a call that never connected as ERR with its error code", () => {
		render(<ConsoleOutput logs={[]} scriptRequests={[REFUSED_CALL]} errors={{}} />);

		const row = screen.getByRole("button", { name: /GET.*127\.0\.0\.1/ });
		expect(row).toHaveTextContent("ERR");
		expect(row).toHaveTextContent("CONNECTION_FAILED");

		fireEvent.click(row);
		expect(screen.getByText("CONNECTION_FAILED: Connection refused")).toBeInTheDocument();
		expect(screen.queryByText("Response headers")).toBeNull();
	});

	it("lists the calls with the console off, rather than saying there is no output", () => {
		render(<ConsoleOutput logs={[]} scriptRequests={[TOKEN_CALL, REFUSED_CALL]} errors={{}} />);

		expect(screen.queryByText("No console output")).toBeNull();
		expect(tokenRow()).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /GET.*127\.0\.0\.1/ })).toBeInTheDocument();
	});

	it.each([
		["the URL", "auth.example"],
		["the method", "post"],
		["the status", "200"],
	])("is found by the filter through %s", (_what, needle) => {
		render(
			<ConsoleOutput
				logs={[{ source: "pre", level: "log", message: "unrelated" }]}
				scriptRequests={[TOKEN_CALL]}
				errors={{}}
			/>
		);

		fireEvent.change(screen.getByLabelText("Filter console output"), {
			target: { value: needle },
		});
		expect(tokenRow()).toBeInTheDocument();
		expect(screen.queryByText("unrelated")).toBeNull();
	});
});

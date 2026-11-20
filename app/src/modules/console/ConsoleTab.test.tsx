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
 * The bottom panel's Console tab (#3634), over the session ring.
 *
 * jsdom has no `IntersectionObserver`, and `useGrowingWindow` then renders
 * every row; an observer that never fires is stubbed in, so the window stays
 * at its first slice and a filter case can name a row that is not drawn until
 * the filter finds it. The report query is mocked at its module, the one the
 * step row reads.
 *
 * Mutation checks: take the window before the filter in `ConsoleList` (filter
 * `listed.slice(-visible)` instead of the ring) and the three "not yet drawn"
 * cases fail; build the Send row's exchange without `maskSensitiveHeaders` in
 * `console-rows.ts` and the cURL and expansion cases fail, the token in the
 * copy and in the Headers tab; do the same to the step's stored exchange in
 * `StepRow` and "opens to the stored exchange" fails; draw `EvictedNotice` whatever
 * `hasMore` says and "above the oldest row held" fails; drop the `useHoldPlace`
 * hook from `ConsoleList` and the reader's place case reads a `scrollTop` of 0;
 * drop the `isExpanded`
 * gate on the report query in `StepRow` and "asks for the report only once the
 * row is open" fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { GROWING_WINDOW_STEP } from "@/hooks/useGrowingWindow";
import { useScenarioRunStore, useTabsStore, useToastStore } from "@/stores";
import { useConsoleStore, type ConsoleRowInput } from "@/stores/console-store";
import type { RunReport } from "@/types";
import type { ResponseState } from "@/modules/request-builder/types";
import { makeScrollable, stubRowLayout } from "@/test/row-layout.testkit";
import { stubSentinelObserver } from "@/test/sentinel-observer.testkit";
import { sendConsoleRows } from "./console-rows";
import { ConsoleTab } from "./ConsoleTab";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: ({ value }: { value: string }) => <pre data-testid="code-editor">{value}</pre>,
}));

interface ReportAnswer {
	data?: RunReport;
	isLoading?: boolean;
	error?: Error | null;
}

const report = vi.hoisted(() => ({
	answer: {} as ReportAnswer,
	asked: [] as (string | null)[],
	refetch: vi.fn(),
}));

vi.mock("@/queries/runs", () => ({
	useRunReportQuery: (runId: string | null) => {
		report.asked.push(runId);
		return {
			data: runId ? report.answer.data : undefined,
			isLoading: runId ? (report.answer.isLoading ?? false) : false,
			error: runId ? (report.answer.error ?? null) : null,
			refetch: report.refetch,
		};
	},
}));

/** An observer that never reports the sentinel, so the window keeps its first slice. */
class NeverIntersecting {
	observe() {}
	disconnect() {}
	unobserve() {}
}

const line = (message: string, level: "log" | "warn" | "error" = "log"): ConsoleRowInput => ({
	kind: "line",
	source: "pre",
	level,
	message,
});

const send = (url: string, status = 200): ConsoleRowInput => ({
	kind: "send",
	method: "GET",
	url,
	status,
	timeMs: 12,
	sizeBytes: 11,
	exchange: {
		requestHeaders: { Accept: "application/json" },
		responseHeaders: { "content-type": "application/json" },
		responseBody: { text: '{"ok":true}' },
	},
});

const scriptRequest = (url: string): ConsoleRowInput => ({
	kind: "scriptRequest",
	source: "pre",
	method: "POST",
	url,
	status: 201,
	timeMs: 4,
	sizeBytes: 2,
	exchange: { requestHeaders: {}, responseHeaders: {} },
});

const step = (overrides: Partial<Extract<ConsoleRowInput, { kind: "step" }>> = {}) =>
	({
		kind: "step",
		runId: "run_7",
		iteration: 0,
		stepIndex: 1,
		name: "Get token",
		outcome: "passed",
		method: "GET",
		url: "https://api.test/token",
		status: 200,
		timeMs: 9,
		sizeBytes: 15,
		...overrides,
	}) satisfies ConsoleRowInput;

const append = (rows: ConsoleRowInput[]) => act(() => useConsoleStore.getState().append(rows));

/** More quiet lines than the window's first slice holds, so the row before them is not drawn. */
const filler = () => Array.from({ length: GROWING_WINDOW_STEP + 1 }, (_, i) => line(`quiet ${i}`));

const listedRows = () =>
	within(screen.getByRole("list", { name: "Console rows" })).queryAllByRole("listitem");

/** The body the viewer's editor holds, which it pretty-prints. */
const editorJson = () => JSON.parse(screen.getByTestId("code-editor").textContent ?? "");

function choose(selectName: string, optionName: string) {
	fireEvent.click(screen.getByRole("combobox", { name: selectName }));
	fireEvent.click(screen.getByRole("option", { name: optionName }));
}

beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", NeverIntersecting);
	useConsoleStore.getState().clear();
	useToastStore.setState({ toasts: [] });
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
	report.answer = {};
	report.asked = [];
	report.refetch.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the Console's list", () => {
	it("says what it will hold while the ring is empty", () => {
		render(<ConsoleTab />);
		expect(screen.getByText(/^Nothing sent yet\./)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
	});

	it("lists the rows oldest first, newest last, and draws a row appended while open", () => {
		append([line("first"), send("https://api.test/second")]);
		render(<ConsoleTab />);
		append([line("third")]);

		const rows = listedRows();
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent("first");
		expect(rows[1]).toHaveTextContent("https://api.test/second");
		expect(rows[2]).toHaveTextContent("third");
	});

	it("draws only the newest slice of a long ring", () => {
		append([line("the oldest line"), ...filler()]);
		render(<ConsoleTab />);
		expect(listedRows()).toHaveLength(GROWING_WINDOW_STEP);
		expect(screen.queryByText("the oldest line")).toBeNull();
	});

	it("follows the newest row while scrolled to the end, and stays put once scrolled up", () => {
		append([line("one")]);
		render(<ConsoleTab />);
		const scroller = screen.getByRole("list", { name: "Console rows" }).parentElement!;
		// jsdom lays nothing out; the scroller's extent is given by hand.
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 100 });

		append([line("two")]);
		expect(scroller.scrollTop).toBe(1000);

		scroller.scrollTop = 200;
		fireEvent.scroll(scroller);
		append([line("three")]);
		expect(scroller.scrollTop).toBe(200);
	});
});

describe("growing the window above the reader", () => {
	it("keeps the reader's place, so the next scroll up grows the window again", () => {
		const observer = stubSentinelObserver();
		stubRowLayout(20);
		append(Array.from({ length: 3 * GROWING_WINDOW_STEP }, (_, i) => line(`quiet ${i}`)));
		render(<ConsoleTab />);
		const list = screen.getByRole("list", { name: "Console rows" });
		const scroller = list.parentElement as HTMLElement;
		makeScrollable(scroller, 0);

		act(() => observer.reach(list.previousElementSibling as Element));
		expect(listedRows()).toHaveLength(2 * GROWING_WINDOW_STEP);
		expect(scroller.scrollTop).toBe(GROWING_WINDOW_STEP * 20);

		scroller.scrollTop = 0;
		act(() => observer.reach(list.previousElementSibling as Element));
		expect(listedRows()).toHaveLength(3 * GROWING_WINDOW_STEP);
		expect(scroller.scrollTop).toBe(GROWING_WINDOW_STEP * 20);
		expect(screen.getByText("quiet 0")).toBeInTheDocument();
	});
});

describe("the Console's filters, over rows not yet drawn", () => {
	it("narrows by type", () => {
		append([scriptRequest("http://localhost:4000/token"), ...filler()]);
		render(<ConsoleTab />);
		expect(screen.queryByText("http://localhost:4000/token")).toBeNull();

		choose("Type", "Script requests");

		expect(listedRows()).toHaveLength(1);
		expect(screen.getByText("http://localhost:4000/token")).toBeInTheDocument();
	});

	it("counts a collection-run step as a request", () => {
		append([step(), line("a line"), send("https://api.test/send")]);
		render(<ConsoleTab />);

		choose("Type", "Requests");

		expect(listedRows().map((row) => row.textContent)).toEqual([
			expect.stringContaining("Get token"),
			expect.stringContaining("https://api.test/send"),
		]);
	});

	it("narrows by level, to console lines of that level", () => {
		append([line("the token expired", "error"), send("https://api.test/x"), ...filler()]);
		render(<ConsoleTab />);
		expect(screen.queryByText("the token expired")).toBeNull();

		choose("Level", "Error");

		expect(listedRows()).toHaveLength(1);
		expect(screen.getByText("the token expired")).toBeInTheDocument();
	});

	it("narrows by text over the method, URL, status and message", () => {
		append([send("https://needle.test/orders", 503), ...filler()]);
		render(<ConsoleTab />);
		const search = screen.getByRole("textbox", { name: "Search the console" });

		fireEvent.change(search, { target: { value: "NEEDLE" } });
		expect(listedRows()).toHaveLength(1);
		expect(screen.getByText("https://needle.test/orders")).toBeInTheDocument();

		fireEvent.change(search, { target: { value: "503" } });
		expect(listedRows()).toHaveLength(1);

		fireEvent.change(search, { target: { value: "quiet 3" } });
		expect(listedRows().length).toBeGreaterThan(1);
	});

	it("says when nothing matches, and clears the filters from there", () => {
		append([line("hello")]);
		render(<ConsoleTab />);
		fireEvent.change(screen.getByRole("textbox", { name: "Search the console" }), {
			target: { value: "nothing like it" },
		});

		expect(screen.getByText("No rows match these filters.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
		expect(screen.getByText("hello")).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "Search the console" })).toHaveValue("");
	});
});

describe("Clear and the dropped rows", () => {
	it("empties the ring, and the list with it", () => {
		append([line("hello"), send("https://api.test/x")]);
		render(<ConsoleTab />);

		fireEvent.click(screen.getByRole("button", { name: "Clear" }));

		expect(useConsoleStore.getState().rows).toHaveLength(0);
		expect(screen.getByText(/^Nothing sent yet\./)).toBeInTheDocument();
	});

	it("says once, at the top, that older rows were dropped", () => {
		append([line("kept")]);
		act(() => useConsoleStore.setState({ evictedCount: 3 }));
		render(<ConsoleTab />);

		const notice = screen.getByText(/^3 older rows dropped/);
		expect(notice).toHaveTextContent("Sends and collection runs stay in History.");
		expect(screen.getAllByText(/older rows? dropped/)).toHaveLength(1);
		expect(
			notice.compareDocumentPosition(screen.getByText("kept")) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it("says it above the oldest row held, not above the window", () => {
		const observer = stubSentinelObserver();
		append([line("the oldest line"), ...filler()]);
		act(() => useConsoleStore.setState({ evictedCount: 3 }));
		render(<ConsoleTab />);
		const list = screen.getByRole("list", { name: "Console rows" });
		expect(screen.queryByText(/older rows? dropped/)).toBeNull();

		act(() => observer.reach(list.previousElementSibling as Element));

		expect(screen.getByText("the oldest line")).toBeInTheDocument();
		expect(screen.getByText(/^3 older rows dropped/)).toBeInTheDocument();
	});

	it("says nothing about dropped rows when none were", () => {
		append([line("kept")]);
		render(<ConsoleTab />);
		expect(screen.queryByText(/older rows? dropped/)).toBeNull();
	});
});

/** A live Send's response, carrying a credential its masking must withhold. */
const liveResponse = (): ResponseState => ({
	status: 200,
	statusText: "OK",
	headers: { "content-type": "application/json" },
	requestHeaders: {
		Authorization: "Bearer live-secret",
		"X-Tenant-Key": "tenant-secret",
		"Content-Type": "application/json",
	},
	rawRequest:
		"POST /orders HTTP/1.1\r\nAuthorization: Bearer live-secret\r\n\r\n" + '{"sku":"a-1"}',
	body: '{"id":7}',
	bodyRaw: '{"id":7}',
	size: 8,
	time: 31,
	authHeaders: ["X-Tenant-Key"],
	authQueryParam: "access_token",
});

describe("a Send row", () => {
	beforeEach(() => {
		append(
			sendConsoleRows({
				method: "POST",
				url: "https://api.test/orders?access_token=query-secret",
				response: liveResponse(),
			})
		);
	});

	const summary = () => screen.getByRole("button", { name: /api\.test\/orders/ });

	it("shows method, masked URL, status, time and size", () => {
		render(<ConsoleTab />);
		const row = listedRows()[0];
		expect(row).toHaveTextContent("POST");
		expect(row).toHaveTextContent("https://api.test/orders?access_token=<redacted>");
		expect(row).toHaveTextContent("200");
		expect(row).toHaveTextContent("31ms");
		expect(row).toHaveTextContent("8 B");
		expect(row).not.toHaveTextContent("query-secret");
	});

	it("opens to the request and response bodies and headers, masked", () => {
		render(<ConsoleTab />);
		fireEvent.click(summary());

		expect(editorJson()).toEqual({ id: 7 });
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Request" }));
		expect(editorJson()).toEqual({ sku: "a-1" });

		fireEvent.mouseDown(screen.getByRole("tab", { name: "Headers" }));
		const panel = screen.getByRole("tabpanel");
		expect(panel).toHaveTextContent("Request headers");
		expect(panel).toHaveTextContent("Response headers");
		expect(panel).toHaveTextContent("<redacted>");
		expect(panel).not.toHaveTextContent("live-secret");
		expect(panel).not.toHaveTextContent("tenant-secret");
	});

	it("copies the masked request as cURL, and says so before the click", async () => {
		const writeText = vi.fn((_text: string) => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		render(<ConsoleTab />);

		const copy = screen.getByRole("button", { name: "Copy as cURL" });
		fireEvent.focus(copy);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"Copy as cURL, with credentials as <redacted>"
		);
		fireEvent.click(copy);

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const code = writeText.mock.calls[0][0];
		expect(code).toContain("curl -X POST 'https://api.test/orders?access_token=<redacted>'");
		expect(code).toContain("-H 'Authorization: <redacted>'");
		expect(code).toContain("-H 'X-Tenant-Key: <redacted>'");
		expect(code).toContain(`--data-raw '{"sku":"a-1"}'`);
		expect(code).not.toMatch(/live-secret|tenant-secret|query-secret/);
	});

	it("offers History only for a Send that knows its run", () => {
		render(<ConsoleTab />);
		expect(screen.queryByRole("button", { name: "Open run" })).toBeNull();
	});
});

describe("a streamed Send's row", () => {
	it("opens its run in History", () => {
		append(
			sendConsoleRows({
				method: "GET",
				url: "https://api.test/events",
				response: liveResponse(),
				runId: "run_42",
			})
		);
		const openTab = vi.fn();
		useTabsStore.setState({ openTab });
		render(<ConsoleTab />);

		fireEvent.click(screen.getByRole("button", { name: "Open run" }));
		expect(openTab).toHaveBeenCalledWith({ type: "run", entityId: "run_42" });
	});
});

/** The run's report, holding the stored row of step 1 of iteration 0. */
const storedReport = (): RunReport =>
	({
		results: [
			{
				timestamp: 1_700_000_000_000,
				statusCode: 200,
				latencyMs: 9,
				trace: {
					iteration: 0,
					stepIndex: 1,
					stepName: "Get token",
					outcome: "passed",
					request: {
						method: "GET",
						url: "https://api.test/token",
						sentHeaders: { Authorization: "Bearer stored-secret", Accept: "*/*" },
					},
					response: {
						headers: { "content-type": "application/json" },
						body: '{"token":"issued"}',
					},
					scripts: {
						consoleLogs: [
							{ source: "pre", level: "log", message: "before the request" },
							{ source: "test", level: "warn", message: "after the response" },
						],
					},
				},
			},
		],
	}) as unknown as RunReport;

describe("a collection-run step's row", () => {
	const summary = () => screen.getByRole("button", { name: /Get token/ });

	it("asks for the report only once the row is open", () => {
		append([step()]);
		render(<ConsoleTab />);
		expect(report.asked.every((runId) => runId === null)).toBe(true);

		fireEvent.click(summary());
		expect(report.asked).toContain("run_7");
	});

	it("opens to the stored exchange, with the scripts' lines around it in the order they ran", () => {
		report.answer = { data: storedReport() };
		append([step()]);
		render(<ConsoleTab />);
		fireEvent.click(summary());

		const before = screen.getByText("before the request");
		const body = screen.getByTestId("code-editor");
		const after = screen.getByText("after the response");
		expect(editorJson()).toEqual({ token: "issued" });
		expect(
			before.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(body.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.mouseDown(screen.getByRole("tab", { name: "Headers" }));
		expect(screen.getByRole("tabpanel")).toHaveTextContent("<redacted>");
		expect(screen.getByRole("tabpanel")).not.toHaveTextContent("stored-secret");
	});

	it("matches the stored row on iteration and position, not on name", () => {
		report.answer = { data: storedReport() };
		append([step({ iteration: 1 })]);
		render(<ConsoleTab />);
		fireEvent.click(summary());

		expect(screen.queryByTestId("code-editor")).toBeNull();
		expect(screen.getByText("History has no stored copy of this step.")).toBeInTheDocument();
	});

	it("says the exchange arrives when the run ends, while the run is still streaming", () => {
		report.answer = { data: { results: [] } as unknown as RunReport };
		useScenarioRunStore.setState({ runId: "run_7", isStreaming: true });
		append([step()]);
		render(<ConsoleTab />);
		fireEvent.click(summary());

		expect(screen.getByText(/appear here once the run finishes/)).toBeInTheDocument();
	});

	it("says it is reading while the report loads", () => {
		report.answer = { isLoading: true };
		append([step()]);
		render(<ConsoleTab />);
		fireEvent.click(summary());

		expect(screen.getByText("Reading this step from History…")).toBeInTheDocument();
	});

	it("says why a read failed, and tries again on request", () => {
		report.answer = { error: new Error("Vayu's engine didn't respond") };
		append([step()]);
		render(<ConsoleTab />);
		fireEvent.click(summary());

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Couldn't read this step from History - Vayu's engine didn't respond"
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(report.refetch).toHaveBeenCalledTimes(1);
	});

	it("opens its run in History", () => {
		append([step()]);
		const openTab = vi.fn();
		useTabsStore.setState({ openTab });
		render(<ConsoleTab />);

		fireEvent.click(screen.getByRole("button", { name: "Open run" }));
		expect(openTab).toHaveBeenCalledWith({ type: "run", entityId: "run_7" });
	});
});

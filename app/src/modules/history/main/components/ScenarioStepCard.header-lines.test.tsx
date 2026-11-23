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
 * A scenario step's Headers tab shows the response's header lines as the stored
 * trace recorded them (issue #2460), the same ones the design-run pane shows.
 * The card builds its viewer props by hand from the restored `ResponseState`,
 * so the field has to be forwarded there or the History pane would keep the
 * folded map while the builder shows the lines.
 *
 * Mutation check: drop `headerLines` from the projection in
 * `ScenarioStepCard.tsx` and the first case fails.
 *
 * The last describe holds an `mcp` data-driven row (#3808): the `Mcp-*` headers
 * the engine derives from the body are in `sentHeaders` and not in the composed
 * `headers`, so reading the composed map in `restore-response.ts`'s `sentSide`
 * makes the first of those cases fail.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import ScenarioStepCard from "./ScenarioStepCard";
import type { ScenarioStepRow } from "../scenario-steps";
import type { RunResultSample } from "@/modules/request-builder/utils/restore-response";

// Monaco under the response body costs a jsdom mount and shows the same text
// the card hands it, which is the question the mcp cases ask.
vi.mock("@/components/shared/response-viewer/ResponseBody", () => ({
	default: ({ body }: { body: string }) => <div data-testid="response-body">{body}</div>,
}));

afterEach(cleanup);

function row(headerLines?: Array<{ name: string; value: string }>): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Login",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 12,
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			latencyMs: 12,
			trace: {
				request: { method: "POST", url: "https://x.test/login" },
				response: {
					headers: { "set-cookie": "a=1, b=2" },
					...(headerLines && { headerLines }),
					body: "ok",
				},
			},
		} as RunResultSample,
	};
}

function headerNames(step: ScenarioStepRow) {
	const { container } = render(
		<ScenarioStepCard
			step={step}
			showIteration={false}
			isExpanded={true}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
	const trigger = screen.getByRole("tab", { name: /headers/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
	return Array.from(container.querySelectorAll("span.font-medium")).map((n) => n.textContent);
}

describe("ScenarioStepCard response headers", () => {
	it("shows one row per stored header line", () => {
		const names = headerNames(
			row([
				{ name: "Set-Cookie", value: "a=1" },
				{ name: "Set-Cookie", value: "b=2" },
			])
		);

		expect(names).toEqual(["Set-Cookie:", "Set-Cookie:"]);
	});

	it("shows the folded map for a row stored before the lines", () => {
		expect(headerNames(row())).toEqual(["set-cookie:"]);
	});
});

const MCP_REQUEST_BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: { name: "execute_sql", arguments: { region: "{{data.region}}" } },
});

/** A JSON-RPC frame, raw: the body is stored as the server sent it. */
const MCP_REPLY_BODY = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	result: { content: [{ type: "text", text: "3 rows affected" }], isError: false },
});

/**
 * An `mcp` request's row 2 of a data run. `headers` is the composed request,
 * which has no `Mcp-*` line: the engine derives them from the body at send time
 * and records them in `sentHeaders`.
 */
function mcpRow(
	overrides: Partial<ScenarioStepRow> = {},
	testResults: unknown[] = []
): ScenarioStepRow {
	return {
		iteration: 0,
		stepIndex: 0,
		name: "Run query",
		outcome: "passed",
		statusCode: 200,
		latencyMs: 30,
		dataRowIndex: 1,
		result: {
			timestamp: 1_750_000_000_000,
			statusCode: 200,
			latencyMs: 30,
			trace: {
				request: {
					method: "POST",
					url: "https://mcp.test/rpc",
					headers: { "Content-Type": "application/json" },
					sentHeaders: {
						"Content-Type": "application/json",
						"Mcp-Method": "tools/call",
						"Mcp-Name": "execute_sql",
						"Mcp-Param-Region": "eu-west",
						"Mcp-Param-Query": "=?base64?U0VMRUNUIDE=?=",
					},
					body: MCP_REQUEST_BODY,
				},
				response: {
					headers: { "content-type": "application/json" },
					body: MCP_REPLY_BODY,
				},
				scripts: { testResults },
			},
		},
		...overrides,
	} as ScenarioStepRow;
}

function renderStep(step: ScenarioStepRow) {
	return render(
		<ScenarioStepCard
			step={step}
			showIteration={false}
			isExpanded={true}
			onToggle={() => {}}
			runId="run_1"
		/>
	);
}

function openHeadersTab() {
	const trigger = screen.getByRole("tab", { name: /headers/i });
	trigger.focus();
	fireEvent.mouseDown(trigger);
}

describe("ScenarioStepCard mcp data-driven row", () => {
	it("names the data row the step ran with", () => {
		renderStep(mcpRow());

		expect(screen.getByText("Row 2")).toBeTruthy();
	});

	it("lists the derived Mcp headers the engine sent", () => {
		renderStep(mcpRow());
		openHeadersTab();

		const sent = screen.getByText("Request headers").parentElement as HTMLElement;
		expect(within(sent).getByText("Mcp-Method:")).toBeTruthy();
		expect(within(sent).getByText("tools/call")).toBeTruthy();
		expect(within(sent).getByText("Mcp-Name:")).toBeTruthy();
		expect(within(sent).getByText("execute_sql")).toBeTruthy();
		expect(within(sent).getByText("Mcp-Param-Region:")).toBeTruthy();
		expect(within(sent).getByText("eu-west")).toBeTruthy();
	});

	it("lists a base64-sentinel Mcp-Param value as it was sent", () => {
		renderStep(mcpRow());
		openHeadersTab();

		expect(screen.getByText("Mcp-Param-Query:")).toBeTruthy();
		expect(screen.getByText("=?base64?U0VMRUNUIDE=?=")).toBeTruthy();
	});

	it("shows the JSON-RPC reply in the response body", () => {
		renderStep(mcpRow());

		expect(screen.getByTestId("response-body").textContent).toContain("3 rows affected");
	});

	it("renders the failed MCP reply test with the engine's sentence", () => {
		renderStep(
			mcpRow({ outcome: "failed" }, [
				{
					name: "MCP reply",
					passed: false,
					error: "tool failure: execute_sql: syntax error near FROM",
				},
			])
		);

		expect(screen.getByText("MCP reply")).toBeTruthy();
		expect(screen.getByText("tool failure: execute_sql: syntax error near FROM")).toBeTruthy();
	});
});

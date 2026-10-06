/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * What a History row says about who started its run, and whether a request is
 * behind it (issue #1817).
 *
 * Two independent marks: "Unsaved" for a run with no request to open it from,
 * and a badge for a run an agent started. Both sit beside the identity span,
 * never inside it - the url stays the row's identity.
 */
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import RunItem from "./RunItem";
import type { Run } from "@/types";

function row(overrides: Partial<Run> = {}): Run {
	return {
		id: "run_1",
		type: "design",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: { url: "https://api.example.test/checkout", method: "POST" },
		...overrides,
	};
}

const noop = () => {};

function renderRow(run: Run) {
	return render(<RunItem run={run} onSelect={noop} onDelete={noop} isDeleting={false} />);
}

describe("the Unsaved marker", () => {
	it("marks a run with no linked request", () => {
		renderRow(row({ requestId: null }));
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("also marks a load run with no linked request", () => {
		renderRow(row({ type: "load", requestId: null }));
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("is absent on a run linked to a request", () => {
		renderRow(row({ requestId: "req_1" }));
		expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
	});

	it("is absent on a collection run, which never links a request", () => {
		renderRow(
			row({
				type: "scenario",
				requestId: null,
				summary: { scenario: { collectionId: "col_1", stepCount: 2 } },
			})
		);
		expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
	});

	it("is absent on a collection run stored before the descriptor existed", () => {
		renderRow(row({ type: "scenario", requestId: null, summary: {} }));
		expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
	});

	it("is absent on a scenario load run, whose type is load", () => {
		renderRow(
			row({
				type: "load",
				requestId: null,
				summary: { mode: "constant_concurrency", scenario: { collectionId: "col_7" } },
			})
		);
		expect(screen.queryByText("Unsaved")).not.toBeInTheDocument();
	});

	it("sits in its own element, leaving the url as the identity", () => {
		renderRow(row({ requestId: null }));
		const marker = screen.getByText("Unsaved");
		const identity = screen.getByText("api.example.test/checkout", { exact: false });
		expect(identity).not.toContainElement(marker);
		expect(marker).not.toContainElement(identity);
		expect(marker.className).toContain("shrink-0");
		expect(identity.className).toContain("truncate");
	});
});

describe("the agent badge", () => {
	it.each([
		["claude-code", "Claude Code"],
		["cursor-vscode", "Cursor"],
	])("shows %s as the product name %s", (client, label) => {
		renderRow(row({ origin: { kind: "mcp", client } }));
		expect(screen.getByText(label)).toBeInTheDocument();
	});

	it("shows an identifier it does not know as sent", () => {
		renderRow(row({ origin: { kind: "mcp", client: "Acme-Agent" } }));
		expect(screen.getByText("Acme-Agent")).toBeInTheDocument();
	});

	it.each([null, undefined])("says MCP client when the agent sent no name (%s)", (client) => {
		renderRow(row({ origin: { kind: "mcp", client } }));
		expect(screen.getByText("MCP client")).toBeInTheDocument();
	});

	it("is a chip that cannot shrink, beside the identity rather than inside it", () => {
		renderRow(row({ origin: { kind: "mcp", client: "claude-code" } }));
		const badge = screen.getByText("Claude Code");
		expect(badge.dataset.slot).toBe("badge");
		expect(badge.className).toContain("shrink-0");
		expect(
			screen.getByText("api.example.test/checkout", { exact: false })
		).not.toContainElement(badge);
	});

	it("names the client in the row's accessible name", () => {
		renderRow(row({ origin: { kind: "mcp", client: "claude-code" } }));
		expect(
			screen.getByRole("button", {
				name: /^Open .* run, completed.*, started by Claude Code$/,
			})
		).toBeInTheDocument();
	});

	it.each([
		["app", { kind: "app" as const, client: null }],
		["other", { kind: "other" as const, client: null }],
		["absent", undefined],
	])("is not shown for an %s origin", (_name, origin) => {
		renderRow(row({ origin }));
		expect(document.querySelector('[data-slot="badge"]')).toBeNull();
		expect(screen.queryByText("MCP client")).not.toBeInTheDocument();
		expect(
			screen
				.getByRole("button", { name: /^Open .* run, completed/ })
				.getAttribute("aria-label")
		).not.toContain("started by");
	});

	it("ignores a client name that arrives with a non-mcp kind", () => {
		renderRow(row({ origin: { kind: "app", client: "claude-code" } }));
		expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
	});
});

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
 * The snippets list under a script editor (#1223).
 *
 * Three claims are worth pinning, because each replaced something the two old
 * Quick Reference blocks could not do: the list *inserts* rather than being
 * retyped, it shows the templates for the editor it sits under rather than all
 * of them, and it remembers whether the user wanted it open across the tab
 * switch that unmounts the panel.
 *
 * The fourth case is the deletion itself: two hand-rolled copies of this idea
 * are gone, and a source scan says so - with a floor, since a scan that reads
 * nothing passes every "is absent" assertion.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ScriptSnippets } from "./ScriptSnippets";
import { useLayoutStore } from "@/stores";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { ScriptCompletion } from "@/types/domain";

const TEMPLATES: ScriptCompletion[] = [
	{
		label: "Set a header",
		kind: 28,
		insertText: 'pm.request.headers["${1:X-Header}"] = ${2:"value"};',
		detail: "Add or replace a header (pre-request)",
		documentation: "",
		context: "pre",
		group: "Request",
	},
	{
		label: "Test: Status code",
		kind: 28,
		insertText: 'pm.test("Status is ${1:200}", function () {});',
		detail: "Test template",
		documentation: "",
		context: "test",
		group: "Tests",
	},
	{
		label: "Set environment variable",
		kind: 28,
		insertText: 'pm.environment.set("${1:key}", ${2:value});',
		detail: "Store a value for later requests",
		documentation: "",
		context: "both",
		group: "Variables",
	},
	// The completion popup's own entries. They are the bulk of the table and
	// have no business in a list of templates.
	{
		label: "pm.response.json",
		kind: 1,
		insertText: "pm.response.json()",
		detail: "",
		documentation: "",
	},
];

const query = vi.hoisted(() => ({
	value: { data: undefined, isPending: true, isError: false } as {
		data?: { completions: ScriptCompletion[] };
		isPending: boolean;
		isError: boolean;
	},
}));

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => query.value,
}));

function served(completions: ScriptCompletion[] = TEMPLATES) {
	query.value = { data: { completions }, isPending: false, isError: false };
}

beforeEach(() => {
	served();
	useLayoutStore.setState({ scriptSnippetsCollapsed: true });
});

function open() {
	fireEvent.click(screen.getByRole("button", { name: /snippets/i }));
}

describe("ScriptSnippets", () => {
	it("starts collapsed, because the editor is what the panel is for", () => {
		render(<ScriptSnippets context="pre" onInsert={() => {}} />);

		expect(screen.queryByPlaceholderText(/filter snippets/i)).not.toBeInTheDocument();
	});

	it("remembers being opened, in the store that survives the tab unmount", () => {
		const { unmount } = render(<ScriptSnippets context="pre" onInsert={() => {}} />);
		open();

		expect(useLayoutStore.getState().scriptSnippetsCollapsed).toBe(false);

		// The Radix tab switch: the panel goes away and comes back.
		unmount();
		render(<ScriptSnippets context="pre" onInsert={() => {}} />);
		expect(screen.getByPlaceholderText(/filter snippets/i)).toBeInTheDocument();
	});

	it("offers a pre-request editor its own templates and the shared one", () => {
		render(<ScriptSnippets context="pre" onInsert={() => {}} />);
		open();

		expect(screen.getByText("Set a header")).toBeInTheDocument();
		expect(screen.getByText("Set environment variable")).toBeInTheDocument();
		expect(screen.queryByText("Test: Status code")).not.toBeInTheDocument();
		// Never the completion popup's plain entries.
		expect(screen.queryByText("pm.response.json")).not.toBeInTheDocument();
	});

	it("offers a test editor the assertions instead", () => {
		render(<ScriptSnippets context="test" onInsert={() => {}} />);
		open();

		expect(screen.getByText("Test: Status code")).toBeInTheDocument();
		expect(screen.queryByText("Set a header")).not.toBeInTheDocument();
	});

	it("hands the caller the template, placeholders and all", () => {
		const onInsert = vi.fn();
		render(<ScriptSnippets context="pre" onInsert={onInsert} />);
		open();

		fireEvent.click(screen.getByText("Set a header").closest("[cmdk-item]")!);

		// The placeholders are the point: they are what Monaco's snippet
		// controller turns into tab stops. A caller handed the expanded text
		// would paste `${1:X-Header}` into the script.
		expect(onInsert).toHaveBeenCalledWith(
			'pm.request.headers["${1:X-Header}"] = ${2:"value"};'
		);
	});

	it("says so when the engine is not answering, rather than looking empty", () => {
		query.value = { data: undefined, isPending: false, isError: true };
		render(<ScriptSnippets context="pre" onInsert={() => {}} />);
		open();

		expect(screen.getByText(/engine, which is not answering/i)).toBeInTheDocument();
	});

	it("counts what it is holding, so a collapsed header still says there is something", () => {
		render(<ScriptSnippets context="pre" onInsert={() => {}} />);

		expect(screen.getByRole("button", { name: /snippets/i }).textContent).toContain("2");
	});
});

describe("the two surfaces it replaced", () => {
	const SOURCES = [
		"app/src/modules/request-builder/components/RequestTabs/panels/script/ScriptPanel.tsx",
		"app/src/modules/request-builder/components/RequestTabs/panels/script/script-variants.tsx",
		"app/src/modules/collections/CollectionDetail/ScriptTab.tsx",
	];

	it("left no second copy of the reference data behind", () => {
		let scanned = 0;
		for (const path of SOURCES) {
			const source = readFileSync(fromRepoRoot(path), "utf-8");
			scanned += source.length;
			expect(source, path).not.toMatch(/\bquickReference\b/);
			expect(source, path).not.toMatch(/\bQUICK_REF\b/);
			// `notes` as the panel's config field. The word is common enough that
			// the field spelling is what is checked, not the word.
			expect(source, path).not.toMatch(/\bnotes: \[/);
		}

		// The floor: three files that exist and hold code, not three empty reads.
		expect(scanned).toBeGreaterThan(10_000);
	});

	it("has both hosts mount the one component", () => {
		for (const path of SOURCES.filter((p) => !p.endsWith("script-variants.tsx"))) {
			expect(readFileSync(fromRepoRoot(path), "utf-8"), path).toContain("<ScriptSnippets");
		}
	});
});

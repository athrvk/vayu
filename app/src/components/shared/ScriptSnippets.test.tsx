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
 * of them, and its collapsed state is the host's to control rather than this
 * component's own (issue #1605 - two script rows on one screen must not share
 * one boolean; `ScriptElementForm.test.tsx` covers the per-row persistence
 * this component only exposes through `onCollapsedChange`).
 *
 * The fourth case is the deletion itself: two hand-rolled copies of this idea
 * are gone, and a source scan says so - with a floor, since a scan that reads
 * nothing passes every "is absent" assertion.
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ScriptSnippets, type ScriptSnippetsProps } from "./ScriptSnippets";
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
});

/**
 * A minimal controlled host, standing in for `ScriptElementForm`'s per-row
 * `useState` - the real component under test is `ScriptSnippets` and its
 * `collapsed`/`onCollapsedChange` contract, not any particular host's storage.
 */
function Controlled(props: Omit<ScriptSnippetsProps, "collapsed" | "onCollapsedChange">) {
	const [collapsed, setCollapsed] = useState(true);
	return <ScriptSnippets {...props} collapsed={collapsed} onCollapsedChange={setCollapsed} />;
}

function open() {
	fireEvent.click(screen.getByRole("button", { name: /snippets/i }));
}

describe("ScriptSnippets", () => {
	it("starts collapsed, because the editor is what the panel is for", () => {
		render(<Controlled context="pre" onInsert={() => ({ placement: "cursor" as const })} />);

		expect(screen.queryByPlaceholderText(/filter snippets/i)).not.toBeInTheDocument();
	});

	it("is controlled: it renders open or closed from the `collapsed` prop, not its own state", () => {
		const { rerender } = render(
			<ScriptSnippets
				context="pre"
				collapsed={false}
				onCollapsedChange={() => {}}
				onInsert={() => ({ placement: "cursor" as const })}
			/>
		);
		expect(screen.getByPlaceholderText(/filter snippets/i)).toBeInTheDocument();

		rerender(
			<ScriptSnippets
				context="pre"
				collapsed={true}
				onCollapsedChange={() => {}}
				onInsert={() => ({ placement: "cursor" as const })}
			/>
		);
		expect(screen.queryByPlaceholderText(/filter snippets/i)).not.toBeInTheDocument();
	});

	it("reports the toggle rather than tracking it, so two mounted rows never share one boolean", () => {
		const onCollapsedChange = vi.fn();
		render(
			<ScriptSnippets
				context="pre"
				collapsed={true}
				onCollapsedChange={onCollapsedChange}
				onInsert={() => ({ placement: "cursor" as const })}
			/>
		);
		open();

		expect(onCollapsedChange).toHaveBeenCalledWith(false);
	});

	it("offers a pre-request editor its own templates and the shared one", () => {
		render(<Controlled context="pre" onInsert={() => ({ placement: "cursor" as const })} />);
		open();

		expect(screen.getByText("Set a header")).toBeInTheDocument();
		expect(screen.getByText("Set environment variable")).toBeInTheDocument();
		expect(screen.queryByText("Test: Status code")).not.toBeInTheDocument();
		// Never the completion popup's plain entries.
		expect(screen.queryByText("pm.response.json")).not.toBeInTheDocument();
	});

	it("offers a test editor the assertions instead", () => {
		render(<Controlled context="test" onInsert={() => ({ placement: "cursor" as const })} />);
		open();

		expect(screen.getByText("Test: Status code")).toBeInTheDocument();
		expect(screen.queryByText("Set a header")).not.toBeInTheDocument();
	});

	it("hands the caller the template, placeholders and all", () => {
		const onInsert = vi.fn(() => ({ placement: "cursor" as const }));
		render(<Controlled context="pre" onInsert={onInsert} />);
		open();

		fireEvent.click(screen.getByText("Set a header").closest("[cmdk-item]")!);

		// The placeholders are the point: they are what Monaco's snippet
		// controller turns into tab stops. A caller handed the expanded text
		// would paste `${1:X-Header}` into the script.
		expect(onInsert).toHaveBeenCalledWith(
			'pm.request.headers["${1:X-Header}"] = ${2:"value"};'
		);
	});

	/*
	 * The insertion lands out of sight of the list that asked for it, so the
	 * list says what happened - the GraphQL explorer's pattern, and its wording.
	 */
	describe("saying what happened", () => {
		function insertFirst() {
			fireEvent.click(screen.getByText("Set a header").closest("[cmdk-item]")!);
		}

		it("names the template and where it went", () => {
			render(
				<Controlled
					context="pre"
					onInsert={() => ({ placement: "end-of-script" as const })}
				/>
			);
			open();
			insertFirst();

			expect(
				screen.getByText("Inserted Set a header at the end of the script.")
			).toBeTruthy();
		});

		it("speaks again when the same template is inserted twice", () => {
			render(
				<Controlled context="pre" onInsert={() => ({ placement: "cursor" as const })} />
			);
			open();
			insertFirst();
			const first = screen.getByText("Inserted Set a header at the cursor.");
			insertFirst();

			/*
			 * A live region only announces when its text changes, so the second
			 * insertion has to arrive as a different node - keyed, as
			 * `ResponseAnnouncer` and the explorer both are. Same text, new
			 * element: silence here reads as the click not landing.
			 */
			expect(screen.getByText("Inserted Set a header at the cursor.")).not.toBe(first);
		});

		it("shows a refusal on screen, not only to a screen reader", () => {
			render(<Controlled context="pre" onInsert={() => null} />);
			open();
			insertFirst();

			// The whole defect this surface was fixed for was a click that, to a
			// sighted user, did nothing.
			const notice = screen.getByRole("status");
			expect(notice.textContent).toMatch(/no editor to go into/i);
		});

		it("clears the refusal once an insertion lands", () => {
			let answer: { placement: "cursor" } | null = null;
			const { rerender } = render(<Controlled context="pre" onInsert={() => answer} />);
			open();
			insertFirst();
			expect(screen.queryByRole("status")).toBeTruthy();

			answer = { placement: "cursor" };
			rerender(<Controlled context="pre" onInsert={() => answer} />);
			insertFirst();

			expect(screen.queryByRole("status")).toBeNull();
		});
	});

	it("says so when the engine is not answering, rather than looking empty", () => {
		query.value = { data: undefined, isPending: false, isError: true };
		render(<Controlled context="pre" onInsert={() => ({ placement: "cursor" as const })} />);
		open();

		expect(screen.getByText(/engine, which is not answering/i)).toBeInTheDocument();
	});

	it("counts what it is holding, so a collapsed header still says there is something", () => {
		render(<Controlled context="pre" onInsert={() => ({ placement: "cursor" as const })} />);

		expect(screen.getByRole("button", { name: /snippets/i }).textContent).toContain("2");
	});
});

describe("the surfaces it replaced", () => {
	/*
	 * Issue #1223 unified two script panels - the request builder's `ScriptPanel`
	 * and the collection's `ScriptTab` - into one `ScriptSnippets` both mounted.
	 * Issue #1512 retired both of those in turn: a script is a `script.pre` /
	 * `script.post` element now, edited through `ScriptElementForm`
	 * (`components/shared/ElementList/`), which both the request builder's
	 * Elements tab and the collection's now render - one file, one mount point,
	 * where there used to be two.
	 */
	const SOURCES = ["app/src/components/shared/ElementList/ScriptElementForm.tsx"];

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

		// The floor: a file that exists and holds code, not an empty read.
		expect(scanned).toBeGreaterThan(500);
	});

	it("mounts the one component", () => {
		for (const path of SOURCES) {
			expect(readFileSync(fromRepoRoot(path), "utf-8"), path).toContain("<ScriptSnippets");
		}
	});
});

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
 * The consuming half of the outline's click-to-scroll: what the query editor
 * does with a reveal command, and what happens to the command afterwards.
 *
 * The writing half is `context-bar/GraphQLSection.test.tsx` and the line
 * arithmetic is `graphql-body.test.ts`. What only exists here is the join - a
 * command served against the *live* buffer, a slot that is empty afterwards
 * whether or not the operation was found, and a command that waits rather than
 * being dropped while Monaco is still loading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { schemaCacheKey, useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { useRevealStore } from "@/lib/graphql/reveal-store";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import {
	editorFocuses,
	editorPositions,
	editorReveals,
	editorValues,
	fakeEditor,
	monacoStub,
	resetEditorStubs,
} from "@/test/monaco-editor-stub";

/** Whether the query editor has mounted yet - the async-Monaco case turns it off. */
let queryEditorMounts = true;

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({
		language,
		value,
		onMount,
	}: {
		language: string;
		value: string;
		onMount?: (editor: unknown, monaco: unknown) => void;
	}) => {
		editorValues.set(language, value);
		useEffect(() => {
			if (language === "graphql" && !queryEditorMounts) return;
			onMount?.(fakeEditor(language), monacoStub());
			// Mount once, exactly as a real editor does.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
		return <div data-testid={`editor-${language}`}>{value}</div>;
	},
}));

const { GraphQLBody } = await import("./GraphQLBody");

const TARGET = {
	url: "https://api.example.com/graphql",
	resolvedUrl: "https://api.example.com/graphql",
	resolvedAuth: null,
} as unknown as SchemaTarget;

/** Two named operations, the second starting on line 5. */
const TWO_OPERATIONS = [
	"query Users {",
	'  user(id: "1") {',
	"    id",
	"  }",
	"}",
	"",
	"mutation Add {",
	'  deletePost(id: "1")',
	"}",
	"",
].join("\n");

const bodyWith = (query: string) => JSON.stringify({ query });

function mount(query: string, requestId: string | null = "r1") {
	function Harness() {
		const [body, setBody] = useState(bodyWith(query));
		const [draft, setDraft] = useState<string | null>(null);
		return (
			<TooltipProvider>
				<GraphQLBody
					body={body}
					onBodyChange={setBody}
					requestId={requestId}
					schemaTarget={TARGET}
					onEditorMount={() => {}}
					method="POST"
					variablesDraft={draft}
					onVariablesDraftChange={setDraft}
				/>
			</TooltipProvider>
		);
	}
	render(<Harness />);
	return {
		revealed: () => editorReveals.get("graphql") ?? [],
		caret: () => editorPositions.get("graphql") ?? null,
		focuses: () => editorFocuses.get("graphql") ?? 0,
		announcement: () => screen.getByRole("status").textContent ?? "",
	};
}

const reveal = (command: { requestId: string | null; name: string | null; index: number }) =>
	act(() => {
		useRevealStore.getState().revealOperation(command);
	});

beforeEach(() => {
	queryEditorMounts = true;
	resetEditorStubs();
	useRevealStore.setState({ pending: null });
	useExplorerStore.setState({ open: false, byKey: {}, lru: [] });
	// A schema already in hand, so mounting introspects nothing.
	const key = schemaCacheKey(TARGET);
	useSchemaCache.setState({
		byKey: { [key]: { status: "ready", schema: fixtureSchema(), error: null, fetchedAt: 1 } },
		lru: [key],
		activeKey: key,
	});
});

afterEach(cleanup);

describe("serving a reveal command", () => {
	it("scrolls to the operation and focuses the editor", () => {
		const view = mount(TWO_OPERATIONS);
		reveal({ requestId: "r1", name: "Add", index: 1 });

		expect(view.revealed()).toEqual([7]);
		expect(view.caret()).toEqual({ lineNumber: 7, column: 1 });
		expect(view.focuses()).toBe(1);
	});

	it("resolves the line against the live buffer, not the line the outline drew", () => {
		// The outline was drawn from a stored document where `Add` was first; the
		// buffer has it second. Matching by name is what keeps the two in step.
		const view = mount(TWO_OPERATIONS);
		reveal({ requestId: "r1", name: "Add", index: 0 });

		expect(view.revealed()).toEqual([7]);
	});

	it("finds the anonymous operation by its position", () => {
		const view = mount('\n{ user(id: "1") { id } }\n');
		reveal({ requestId: "r1", name: null, index: 0 });

		expect(view.revealed()).toEqual([2]);
	});

	it("empties the slot once served, so a remount does not scroll again", () => {
		mount(TWO_OPERATIONS);
		reveal({ requestId: "r1", name: "Add", index: 1 });

		// Mutation check: drop the `clearReveal()` call and the Body tab, which
		// Radix remounts on every glance at Headers, jumps back here for good.
		expect(useRevealStore.getState().pending).toBeNull();
	});
});

describe("when the command cannot be served", () => {
	it("says so out loud rather than scrolling to nothing", () => {
		const view = mount(TWO_OPERATIONS);
		reveal({ requestId: "r1", name: "Renamed", index: 0 });

		expect(view.revealed()).toEqual([]);
		expect(view.announcement()).toBe("Renamed is no longer in this document.");
		// Kept out of the slot all the same - an unservable command is replayed
		// exactly as a served one would be.
		expect(useRevealStore.getState().pending).toBeNull();
	});

	it("leaves another request's command alone", () => {
		const view = mount(TWO_OPERATIONS, "r2");
		const command = { requestId: "r1", name: "Add", index: 1 };
		reveal(command);

		expect(view.revealed()).toEqual([]);
		// Not cleared either: this editor is not the one it was written for, and
		// the provider is what drops a command nothing can serve.
		expect(useRevealStore.getState().pending).toEqual(command);
	});

	it("waits for Monaco rather than dropping the command it arrived before", () => {
		queryEditorMounts = false;
		const view = mount(TWO_OPERATIONS);
		reveal({ requestId: "r1", name: "Add", index: 1 });

		expect(view.revealed()).toEqual([]);
		expect(useRevealStore.getState().pending).not.toBeNull();

		// The editor arrives a moment later - the tab-was-hidden case, where this
		// component mounts *because* of the command.
		queryEditorMounts = true;
		cleanup();
		const second = mount(TWO_OPERATIONS);
		expect(second.revealed()).toEqual([7]);
		expect(useRevealStore.getState().pending).toBeNull();
	});
});

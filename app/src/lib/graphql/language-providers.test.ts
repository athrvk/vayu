/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Monaco half of the GraphQL editor - the only lib module the 2026-08-08
 * sweep found with no test file at all, which is how `" "` sat in
 * `triggerCharacters` under a comment saying it must not be.
 *
 * Node env against a Monaco stub, following `variables-schema.test.ts`: none of
 * this needs a DOM, and the registrations are plain objects the stub can hand
 * back for the test to drive directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as Monaco from "monaco-editor";
import { registerGraphqlProviders, toMonacoCompletionKind } from "./language-providers";
import { useSchemaCache } from "./schema-cache";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { TIMING } from "@/config/timing";

/** Monaco's own kind numbering, which shares its *names* with LSP's and nothing else. */
const MONACO_KINDS = {
	Method: 0,
	Function: 1,
	Constructor: 2,
	Field: 3,
	Variable: 4,
	Class: 5,
	Struct: 6,
	Interface: 7,
	Module: 8,
	Property: 9,
	Event: 10,
	Operator: 11,
	Unit: 12,
	Value: 13,
	Constant: 14,
	Enum: 15,
	EnumMember: 16,
	Keyword: 17,
	Text: 18,
} as const;

interface StubModel {
	uri: string;
	value: string;
	languageId: string;
	disposed: boolean;
	contentListeners: (() => void)[];
	disposeListeners: (() => void)[];
	getValue: () => string;
	getLanguageId: () => string;
	isDisposed: () => boolean;
	onDidChangeContent: (fn: () => void) => void;
	onWillDispose: (fn: () => void) => void;
	getFullModelRange: () => string;
	getWordUntilPosition: () => { startColumn: number; endColumn: number };
	setValue: (next: string) => void;
	dispose: () => void;
}

function stubModel(value: string, languageId = "graphql"): StubModel {
	const model: StubModel = {
		uri: "inmemory://model/1",
		value,
		languageId,
		disposed: false,
		contentListeners: [],
		disposeListeners: [],
		getValue: () => model.value,
		getLanguageId: () => model.languageId,
		isDisposed: () => model.disposed,
		onDidChangeContent: (fn) => model.contentListeners.push(fn),
		onWillDispose: (fn) => model.disposeListeners.push(fn),
		getFullModelRange: () => "FULL_RANGE",
		getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }),
		setValue: (next) => {
			model.value = next;
			model.contentListeners.forEach((fn) => fn());
		},
		dispose: () => {
			model.disposeListeners.forEach((fn) => fn());
			model.disposed = true;
		},
	};
	return model;
}

function stubMonaco() {
	const models: StubModel[] = [];
	const created: ((model: StubModel) => void)[] = [];
	const registry: Record<string, unknown> = {};
	const setModelMarkers = vi.fn();
	const monaco = {
		MarkerSeverity: { Error: 8, Warning: 4 },
		editor: {
			onDidCreateModel: (fn: (model: StubModel) => void) => created.push(fn),
			setModelMarkers,
			getModels: () => models,
		},
		languages: {
			CompletionItemKind: MONACO_KINDS,
			registerCompletionItemProvider: (_lang: string, provider: unknown) => {
				registry.completion = provider;
			},
			registerHoverProvider: (_lang: string, provider: unknown) => {
				registry.hover = provider;
			},
			registerDocumentFormattingEditProvider: (_lang: string, provider: unknown) => {
				registry.formatting = provider;
			},
		},
	};
	return {
		monaco: monaco as unknown as typeof Monaco,
		setModelMarkers,
		/** Announce a model the way Monaco does, and keep it in `getModels()`. */
		addModel(model: StubModel) {
			models.push(model);
			created.forEach((fn) => fn(model));
			return model;
		},
		completion: () => registry.completion as Monaco.languages.CompletionItemProvider,
		formatting: () => registry.formatting as Monaco.languages.DocumentFormattingEditProvider,
	};
}

/** Put a schema in the cache as the active one, or clear it. */
function activate(schema: ReturnType<typeof fixtureSchema> | null) {
	useSchemaCache.setState({
		byKey: { k: { status: "ready", schema, error: null, fetchedAt: 1 } },
		lru: ["k"],
		activeKey: "k",
	} as never);
}

beforeEach(() => {
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null } as never);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("toMonacoCompletionKind", () => {
	const monaco = { languages: { CompletionItemKind: MONACO_KINDS } } as unknown as typeof Monaco;

	it("maps each LSP kind to Monaco's number for the same name", () => {
		// LSP: Field=5, Variable=6, Enum=13, EnumMember=20, Keyword=14.
		expect(toMonacoCompletionKind(monaco, 5)).toBe(MONACO_KINDS.Field);
		expect(toMonacoCompletionKind(monaco, 6)).toBe(MONACO_KINDS.Variable);
		expect(toMonacoCompletionKind(monaco, 13)).toBe(MONACO_KINDS.Enum);
		expect(toMonacoCompletionKind(monaco, 20)).toBe(MONACO_KINDS.EnumMember);
		expect(toMonacoCompletionKind(monaco, 14)).toBe(MONACO_KINDS.Keyword);
	});

	it("falls back to Field for a kind Monaco has no name for", () => {
		expect(toMonacoCompletionKind(monaco, undefined)).toBe(MONACO_KINDS.Field);
		expect(toMonacoCompletionKind(monaco, 999)).toBe(MONACO_KINDS.Field);
	});
});

describe("the completion provider", () => {
	it("does not trigger on a space", () => {
		const { monaco, completion } = stubMonaco();
		registerGraphqlProviders(monaco);
		const triggers = completion().triggerCharacters ?? [];
		// The provider's own comment has said "NOT space/newline" since it was
		// written; space popped the widget so the next Enter accepted a suggestion
		// instead of breaking the line.
		expect(triggers).not.toContain(" ");
		expect(triggers).not.toContain("\n");
		expect(triggers).toEqual([":", "(", "{", "@", "$"]);
	});

	it("gives each suggestion the kind the language service classified it as", () => {
		const { monaco, completion } = stubMonaco();
		registerGraphqlProviders(monaco);
		activate(fixtureSchema());

		const kindsAt = (doc: string) => {
			const result = completion().provideCompletionItems(
				stubModel(doc) as unknown as Monaco.editor.ITextModel,
				{ lineNumber: 1, column: doc.length + 1 } as Monaco.Position,
				{} as Monaco.languages.CompletionContext,
				{} as Monaco.CancellationToken
			) as Monaco.languages.CompletionList;
			return result.suggestions;
		};

		/*
		 * The defect: every item arrived as `Field`, so an enum value, a directive
		 * and a field wore the same icon. Each of these is a distinct Monaco kind
		 * that the flattened version could not produce.
		 */
		const enumValues = kindsAt('query { search(term: "a", ranking: ');
		expect(enumValues.map((s) => s.label)).toContain("RELEVANCE");
		expect(new Set(enumValues.map((s) => s.kind))).toEqual(new Set([MONACO_KINDS.EnumMember]));

		const directives = kindsAt("query { user(id: 1) { name @");
		expect(directives.map((s) => s.label)).toContain("skip");
		expect(new Set(directives.map((s) => s.kind))).toEqual(new Set([MONACO_KINDS.Function]));

		const fields = kindsAt("query { user(id: 1) { ");
		expect(fields.map((s) => s.label)).toContain("handle");
		expect(new Set(fields.map((s) => s.kind))).toEqual(new Set([MONACO_KINDS.Field]));
	});

	it("offers nothing without a schema", () => {
		const { monaco, completion } = stubMonaco();
		registerGraphqlProviders(monaco);
		const result = completion().provideCompletionItems(
			stubModel("query { ") as unknown as Monaco.editor.ITextModel,
			{ lineNumber: 1, column: 9 } as Monaco.Position,
			{} as Monaco.languages.CompletionContext,
			{} as Monaco.CancellationToken
		) as Monaco.languages.CompletionList;
		expect(result.suggestions).toEqual([]);
	});
});

describe("the marker lifecycle", () => {
	it("validates a graphql model as soon as it is created, and ignores other languages", () => {
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		activate(fixtureSchema());

		addModel(stubModel("query { user(id: 1) { nope } }"));
		expect(setModelMarkers).toHaveBeenCalledTimes(1);
		const markers = setModelMarkers.mock.calls[0][2] as { message: string }[];
		expect(markers.some((m) => /nope/.test(m.message))).toBe(true);

		setModelMarkers.mockClear();
		addModel(stubModel("{ not: graphql }", "json"));
		expect(setModelMarkers).not.toHaveBeenCalled();
	});

	it("maps severity onto Monaco's enum, warnings included", () => {
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		activate(fixtureSchema());

		addModel(stubModel("query { user(id: 1) { nickname } }"));
		const markers = setModelMarkers.mock.calls[0][2] as { severity: number }[];
		expect(markers).toHaveLength(1);
		// 4 is Warning; collapsing this branch onto Error paints deprecations red.
		expect(markers[0].severity).toBe(4);

		setModelMarkers.mockClear();
		addModel(stubModel("query { nope }"));
		expect((setModelMarkers.mock.calls[0][2] as { severity: number }[])[0].severity).toBe(8);
	});

	it("re-validates on a content change, once the debounce elapses", () => {
		vi.useFakeTimers();
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		activate(fixtureSchema());
		const model = addModel(stubModel("query { user(id: 1) { name } }"));
		setModelMarkers.mockClear();

		model.setValue("query { user(id: 1) { nope } }");
		expect(setModelMarkers).not.toHaveBeenCalled();
		vi.advanceTimersByTime(TIMING.GRAPHQL_DIAGNOSTICS_DEBOUNCE_MS);
		expect(setModelMarkers).toHaveBeenCalledTimes(1);
	});

	it("does not fire a pending debounce at a disposed model", () => {
		vi.useFakeTimers();
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		activate(fixtureSchema());
		const model = addModel(stubModel("query { user(id: 1) { name } }"));
		setModelMarkers.mockClear();

		model.setValue("query { nope }");
		model.dispose();
		vi.advanceTimersByTime(TIMING.GRAPHQL_DIAGNOSTICS_DEBOUNCE_MS * 4);
		expect(setModelMarkers).not.toHaveBeenCalled();
	});
});

describe("the schema subscription", () => {
	it("re-validates open graphql models when the schema itself changes", () => {
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		addModel(stubModel("query { user(id: 1) { nickname } }"));
		setModelMarkers.mockClear();

		activate(fixtureSchema());
		expect(setModelMarkers).toHaveBeenCalledTimes(1);
		expect(setModelMarkers.mock.calls[0][2]).toHaveLength(1);
	});

	it("ignores a store change that leaves the schema reference alone", () => {
		const { monaco, addModel, setModelMarkers } = stubMonaco();
		registerGraphqlProviders(monaco);
		const schema = fixtureSchema();
		activate(schema);
		addModel(stubModel("query { user(id: 1) { name } }"));
		setModelMarkers.mockClear();

		// A status/freshness write against the same schema object. Re-validating
		// here would run a full pass over every open model on every poll.
		useSchemaCache.setState({
			byKey: { k: { status: "ready", schema, error: null, fetchedAt: 2 } },
		} as never);
		expect(setModelMarkers).not.toHaveBeenCalled();
	});
});

describe("the formatting provider", () => {
	const model = (value: string) => stubModel(value) as unknown as Monaco.editor.ITextModel;

	it("replaces the whole document with the formatted text", async () => {
		const { monaco, formatting } = stubMonaco();
		registerGraphqlProviders(monaco);
		const edits = await formatting().provideDocumentFormattingEdits(
			model("query    {   user(id: 1) { name } }"),
			{} as Monaco.languages.FormattingOptions,
			{} as Monaco.CancellationToken
		);
		expect(edits).toHaveLength(1);
		expect(edits?.[0].text).toBe("query {\n  user(id: 1) {\n    name\n  }\n}\n");
	});

	it("edits nothing when the document cannot be parsed", async () => {
		const { monaco, formatting } = stubMonaco();
		registerGraphqlProviders(monaco);
		const edits = await formatting().provideDocumentFormattingEdits(
			model("query { user(id: "),
			{} as Monaco.languages.FormattingOptions,
			{} as Monaco.CancellationToken
		);
		expect(edits).toEqual([]);
	});

	/*
	 * The formatter is loaded on demand, so there is a gap between reading the
	 * text and producing the edit. An edit computed from text the user has since
	 * changed would overwrite the newer keystrokes with the older document.
	 */
	it("abandons the edit when the model changed while it was formatting", async () => {
		const { monaco, formatting } = stubMonaco();
		registerGraphqlProviders(monaco);
		const live = stubModel("query    {   user(id: 1) { name } }");
		const pending = formatting().provideDocumentFormattingEdits(
			live as unknown as Monaco.editor.ITextModel,
			{} as Monaco.languages.FormattingOptions,
			{} as Monaco.CancellationToken
		);
		live.setValue("query { user(id: 2) { name } }");
		expect(await pending).toEqual([]);
	});
});

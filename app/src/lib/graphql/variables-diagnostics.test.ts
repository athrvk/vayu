/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Two halves, because the claim has two halves.
 *
 * The wiring - twin created, text mirrored, markers copied, nothing leaked - is
 * driven through a Monaco stub in the node env, following
 * `language-providers.test.ts`. What the markers actually *say* is not a thing a
 * stub can answer, so the second half runs Monaco's real JSON worker over the
 * same text: it is the code that paints the squiggle, and it is what proves a
 * templated document comes out clean while a broken one does not.
 */

import { describe, it, expect, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { JSONWorker } from "monaco-editor/languages/features/json/jsonWorker.js";
import {
	attachVariablesDiagnostics,
	markersOutsideTemplates,
	templateTwinUri,
} from "./variables-diagnostics";
import { maskJsonTemplatesInPlace } from "./templates";
import { buildVariablesJsonSchema } from "./variables-schema";
import { fixtureSchema } from "@/test/graphql-schema-fixture";

const MODEL_URI = "inmemory://model/1";

interface StubModel {
	uri: { toString: () => string };
	value: string;
	languageId: string;
	disposed: boolean;
	contentListeners: (() => void)[];
	disposeListeners: (() => void)[];
	getValue: () => string;
	setValue: (next: string) => void;
	isDisposed: () => boolean;
	onDidChangeContent: (fn: () => void) => { dispose: () => void };
	onWillDispose: (fn: () => void) => { dispose: () => void };
	dispose: () => void;
}

function stubModel(uri: string, value: string, languageId = "json"): StubModel {
	const model: StubModel = {
		uri: { toString: () => uri },
		value,
		languageId,
		disposed: false,
		contentListeners: [],
		disposeListeners: [],
		getValue: () => model.value,
		setValue: (next) => {
			model.value = next;
			model.contentListeners.forEach((fn) => fn());
		},
		isDisposed: () => model.disposed,
		onDidChangeContent: (fn) => {
			model.contentListeners.push(fn);
			return { dispose: () => {} };
		},
		onWillDispose: (fn) => {
			model.disposeListeners.push(fn);
			return { dispose: () => {} };
		},
		dispose: () => {
			model.disposeListeners.forEach((fn) => fn());
			model.disposed = true;
		},
	};
	return model;
}

type StubMarker = Monaco.editor.IMarkerData & { owner?: string };

/** Monaco's marker bookkeeping, down to the parts this module touches. */
function stubMonaco() {
	const models = new Map<string, StubModel>();
	const markers = new Map<string, StubMarker[]>();
	const markerListeners: ((uris: { toString: () => string }[]) => void)[] = [];
	const setModelMarkers = vi.fn((model: StubModel, owner: string, next: StubMarker[]) => {
		markers.set(`${model.uri.toString()}|${owner}`, next);
		markerListeners.forEach((fn) => fn([model.uri]));
	});
	const monaco = {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		editor: {
			createModel: (value: string, languageId: string, uri: { toString: () => string }) => {
				const model = stubModel(uri.toString(), value, languageId);
				models.set(uri.toString(), model);
				return model;
			},
			getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
			getModelMarkers: (filter: { resource?: { toString: () => string }; owner?: string }) =>
				markers.get(`${filter.resource?.toString() ?? ""}|${filter.owner ?? ""}`) ?? [],
			setModelMarkers,
			onDidChangeMarkers: (fn: (uris: { toString: () => string }[]) => void) => {
				markerListeners.push(fn);
				return { dispose: () => markerListeners.splice(markerListeners.indexOf(fn), 1) };
			},
		},
	};
	return {
		monaco: monaco as unknown as typeof Monaco,
		setModelMarkers,
		twin: () => models.get(templateTwinUri(MODEL_URI)),
		/** Publish markers the way the JSON worker does, event and all. */
		publish(uri: string, next: StubMarker[]) {
			markers.set(`${uri}|json`, next);
			markerListeners.forEach((fn) => fn([{ toString: () => uri }]));
		},
	};
}

/** The most recent `setModelMarkers` call, which is the state the pane is in. */
function lastCall<T extends unknown[]>(spy: { mock: { calls: T[] } }): T {
	return spy.mock.calls[spy.mock.calls.length - 1];
}

const marker = (message: string, startColumn: number, endColumn: number, line = 1): StubMarker => ({
	message,
	severity: 8,
	startLineNumber: line,
	startColumn,
	endLineNumber: line,
	endColumn,
});

describe("attachVariablesDiagnostics", () => {
	it("mirrors the pane's text into the twin, masked", () => {
		const { monaco, twin } = stubMonaco();
		const model = stubModel(MODEL_URI, '{"limit": {{n}}}');
		attachVariablesDiagnostics(monaco, model as unknown as Monaco.editor.ITextModel);
		expect(twin()?.getValue()).toBe('{"limit": "VVV"}');

		model.setValue('{"limit": {{n}}, "name": "x"}');
		expect(twin()?.getValue()).toBe('{"limit": "VVV", "name": "x"}');
	});

	it("publishes the twin's markers on the pane, minus the ones a token earned", () => {
		const { monaco, setModelMarkers, publish } = stubMonaco();
		const model = stubModel(MODEL_URI, '{"limit": {{n}}, "name": 5}');
		attachVariablesDiagnostics(monaco, model as unknown as Monaco.editor.ITextModel);

		// Columns are 1-based: the token sits at 11..16, `5` at 26..27.
		publish(templateTwinUri(MODEL_URI), [
			marker('Incorrect type. Expected "number".', 11, 16),
			marker('Incorrect type. Expected "string".', 26, 27),
		]);

		const [target, owner, published] = lastCall(setModelMarkers);
		expect(target.uri.toString()).toBe(MODEL_URI);
		// The worker's own owner, so this replaces its markers instead of doubling them.
		expect(owner).toBe("json");
		expect(published.map((m) => m.message)).toEqual(['Incorrect type. Expected "string".']);
	});

	it("corrects the markers the worker writes on the pane itself", () => {
		const { monaco, setModelMarkers, publish } = stubMonaco();
		const model = stubModel(MODEL_URI, '{"limit": {{n}}}');
		attachVariablesDiagnostics(monaco, model as unknown as Monaco.editor.ITextModel);

		// The worker validates the visible model too, and its verdict on the
		// unmasked text is the squiggle this whole module exists to remove.
		publish(MODEL_URI, [marker("End of file expected.", 16, 17)]);

		expect(lastCall(setModelMarkers)[2]).toEqual([]);
	});

	it("does not rewrite markers it has already written", () => {
		const { monaco, setModelMarkers, publish } = stubMonaco();
		const model = stubModel(MODEL_URI, '{"name": 5}');
		attachVariablesDiagnostics(monaco, model as unknown as Monaco.editor.ITextModel);

		publish(templateTwinUri(MODEL_URI), [marker('Incorrect type. Expected "string".', 10, 11)]);
		const afterFirst = setModelMarkers.mock.calls.length;
		// Writing markers fires the event that got us here; an unconditional write
		// would be an endless loop rather than a settled state.
		expect(afterFirst).toBe(1);

		publish(templateTwinUri(MODEL_URI), [marker('Incorrect type. Expected "string".', 10, 11)]);
		expect(setModelMarkers.mock.calls.length).toBe(afterFirst);
	});

	it("takes the twin and the listeners with it when disposed", () => {
		const { monaco, setModelMarkers, twin, publish } = stubMonaco();
		const model = stubModel(MODEL_URI, '{"limit": {{n}}}');
		const attached = attachVariablesDiagnostics(
			monaco,
			model as unknown as Monaco.editor.ITextModel
		);

		attached.dispose();
		expect(twin()?.isDisposed()).toBe(true);

		const before = setModelMarkers.mock.calls.length;
		publish(templateTwinUri(MODEL_URI), [marker("Value expected", 1, 2)]);
		expect(setModelMarkers.mock.calls.length).toBe(before);
	});

	it("cleans up when the pane's model is disposed under it", () => {
		const { monaco, twin } = stubMonaco();
		const model = stubModel(MODEL_URI, "{}");
		attachVariablesDiagnostics(monaco, model as unknown as Monaco.editor.ITextModel);

		model.dispose();
		expect(twin()?.isDisposed()).toBe(true);
	});

	it("replaces a twin an earlier attach left behind", () => {
		const { monaco, twin } = stubMonaco();
		const first = stubModel(MODEL_URI, "{}");
		attachVariablesDiagnostics(monaco, first as unknown as Monaco.editor.ITextModel);
		const stale = twin();

		// createModel throws on a live URI, so a second attach on the same model
		// URI has to clear the first one's twin rather than trip over it.
		attachVariablesDiagnostics(monaco, first as unknown as Monaco.editor.ITextModel);
		expect(stale?.isDisposed()).toBe(true);
		expect(twin()?.isDisposed()).toBe(false);
	});
});

/**
 * Monaco's own JSON worker, driven directly.
 *
 * It is the thing that decides what the pane paints, it is bundled in
 * `monaco-editor` rather than mocked here, and a stub cannot answer the only
 * question that matters: whether the masked document is *clean*. A monaco
 * upgrade that moves this module breaks the import, which is a loud failure and
 * the point of reaching for the real one.
 */
async function workerMarkers(text: string, jsonSchema: unknown) {
	const uri = "inmemory://model/variables.json";
	const worker = new JSONWorker(
		{ getMirrorModels: () => [{ uri: { toString: () => uri }, getValue: () => text }] },
		{
			languageId: "json",
			languageSettings: {
				validate: true,
				allowComments: true,
				enableSchemaRequest: false,
				schemas: [{ uri: "inmemory://vars.json", fileMatch: [uri], schema: jsonSchema }],
			},
		}
	);
	const diagnostics = await worker.doValidation(uri);
	return diagnostics.map((d) => ({
		message: d.message,
		severity: 8,
		startLineNumber: d.range.start.line + 1,
		startColumn: d.range.start.character + 1,
		endLineNumber: d.range.end.line + 1,
		endColumn: d.range.end.character + 1,
	}));
}

/** What the pane ends up showing for `text`: masked, validated, filtered. */
async function paneMarkers(text: string, jsonSchema: unknown) {
	const { masked, spans } = maskJsonTemplatesInPlace(text);
	return markersOutsideTemplates(await workerMarkers(masked, jsonSchema), spans);
}

describe("what Monaco's JSON worker makes of the masked text", () => {
	const jsonSchema = buildVariablesJsonSchema(
		"query ($id: ID!, $first: Int) { user(id: $id) { posts(first: $first) { id } } }",
		fixtureSchema()
	);

	it("leaves a templated document clean", async () => {
		expect(await paneMarkers('{"id": "u1", "first": {{n}}}', jsonSchema)).toEqual([]);
	});

	it("is why the twin exists - the same text unmasked is three squiggles", async () => {
		// Remove the mask and the pane goes back to arguing with its own badge.
		// One of the three even lands *outside* the token (`End of file expected`
		// on the character after it), which is why filtering alone cannot work.
		const raw = await workerMarkers('{"id": "u1", "first": {{n}}}', jsonSchema);
		expect(raw.map((m) => m.message)).toEqual([
			"Incorrect type. Expected one of integer, null.",
			"Property expected",
			"End of file expected.",
		]);
		const { spans } = maskJsonTemplatesInPlace('{"id": "u1", "first": {{n}}}');
		expect(markersOutsideTemplates(raw, spans)).toHaveLength(1);
	});

	it("still reports a genuinely malformed document", async () => {
		const markers = await paneMarkers('{"id": "u1", "first": }', jsonSchema);
		expect(markers.map((m) => m.message)).toContain("Value expected");
	});

	it("still reports a mistake that sits beside a token", async () => {
		// Before the twin this was invisible: the parse gave up at the token, so
		// nothing after it was checked at all.
		const markers = await paneMarkers('{"id": "u1", "first": {{n}}, "extra" 1}', jsonSchema);
		expect(markers.map((m) => m.message)).toContain("Colon expected");
	});

	it("still reports a variable whose value has the wrong type", async () => {
		const markers = await paneMarkers('{"id": "u1", "first": "ten"}', jsonSchema);
		expect(markers.map((m) => m.message)).toContain(
			"Incorrect type. Expected one of integer, null."
		);
	});

	it("still reports a missing required variable", async () => {
		const markers = await paneMarkers('{"first": {{n}}}', jsonSchema);
		expect(markers.map((m) => m.message)).toContain('Missing property "id".');
	});
});

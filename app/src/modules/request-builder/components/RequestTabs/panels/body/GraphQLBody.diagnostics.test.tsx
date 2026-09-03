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
 * That the Variables pane is actually wired to the two things that make it
 * smart, which no test above this file could see.
 *
 * Both hang off the editor's `onMount`, and every other GraphQLBody test mocks
 * `CodeEditor` as a `<div>` that never mounts one - so the schema registration
 * and the masked twin were reachable only through code nothing exercised. This
 * mock hands the component a Monaco stub and lets it mount for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useSchemaCache, schemaCacheKey, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { templateTwinUri } from "@/lib/graphql/variables-diagnostics";

const VARIABLES_URI = "inmemory://model/7";

interface StubModel {
	uri: { toString: () => string };
	value: string;
	disposed: boolean;
	getValue: () => string;
	setValue: (next: string) => void;
	isDisposed: () => boolean;
	onDidChangeContent: (fn: () => void) => { dispose: () => void };
	onWillDispose: (fn: () => void) => { dispose: () => void };
	dispose: () => void;
}

function stubModel(uri: string, value: string): StubModel {
	const model: StubModel = {
		uri: { toString: () => uri },
		value,
		disposed: false,
		getValue: () => model.value,
		setValue: (next) => {
			model.value = next;
		},
		isDisposed: () => model.disposed,
		onDidChangeContent: () => ({ dispose: () => {} }),
		onWillDispose: () => ({ dispose: () => {} }),
		dispose: () => {
			model.disposed = true;
		},
	};
	return model;
}

const created = new Map<string, StubModel>();
const setDiagnosticsOptions = vi.fn();

function stubMonaco() {
	return {
		Uri: { parse: (uri: string) => ({ toString: () => uri }) },
		json: {
			jsonDefaults: { diagnosticsOptions: { schemas: [] }, setDiagnosticsOptions },
		},
		editor: {
			createModel: (value: string, _language: string, uri: { toString: () => string }) => {
				const model = stubModel(uri.toString(), value);
				created.set(uri.toString(), model);
				return model;
			},
			getModel: (uri: { toString: () => string }) => created.get(uri.toString()) ?? null,
			getModelMarkers: () => [],
			setModelMarkers: vi.fn(),
			onDidChangeMarkers: () => ({ dispose: () => {} }),
		},
	};
}

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
		useEffect(() => {
			if (language !== "json") return;
			const model = stubModel(VARIABLES_URI, value);
			onMount?.({ getModel: () => model }, stubMonaco());
			// Mount once, exactly as a real editor does.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
		return <div data-testid={`editor-${language}`} />;
	},
}));

const { GraphQLBody } = await import("./GraphQLBody");

const URL = "https://api.test/gql";
const TARGET: SchemaTarget = { url: URL, resolvedUrl: URL, headers: {}, resolvedAuth: null };
const BODY = JSON.stringify({
	query: "query ($id: ID!) { user(id: $id) { name } }",
	variables: { id: "{{userId}}" },
});

function renderBody() {
	return render(
		<TooltipProvider>
			<GraphQLBody
				body={BODY}
				onBodyChange={() => {}}
				requestId="r1"
				schemaTarget={TARGET}
				onEditorMount={() => {}}
				method="POST"
				variablesDraft={'{"limit": {{n}}}'}
				onVariablesDraftChange={() => {}}
			/>
		</TooltipProvider>
	);
}

beforeEach(() => {
	created.clear();
	setDiagnosticsOptions.mockClear();
	const key = schemaCacheKey(TARGET);
	useSchemaCache.setState({
		byKey: { [key]: { status: "ready", schema: fixtureSchema(), error: null, fetchedAt: 1 } },
		lru: [key],
		activeKey: key,
	});
});
afterEach(cleanup);

describe("the Variables pane's mount", () => {
	it("gives the pane a masked twin to be validated through", () => {
		renderBody();
		const twin = created.get(templateTwinUri(VARIABLES_URI));
		// The pane's own text, with the token replaced by a same-length string.
		expect(twin?.getValue()).toBe('{"limit": "VVV"}');
	});

	it("registers the variables schema against the pane and its twin", () => {
		renderBody();
		const calls = setDiagnosticsOptions.mock.calls;
		const applied = calls[calls.length - 1][0] as { schemas: { fileMatch?: string[] }[] };
		const registered = applied.schemas[applied.schemas.length - 1];
		expect(registered.fileMatch).toEqual([VARIABLES_URI, templateTwinUri(VARIABLES_URI)]);
	});

	it("takes the twin down with the tab, which Radix unmounts constantly", () => {
		const view = renderBody();
		view.unmount();
		expect(created.get(templateTwinUri(VARIABLES_URI))?.isDisposed()).toBe(true);
	});
});

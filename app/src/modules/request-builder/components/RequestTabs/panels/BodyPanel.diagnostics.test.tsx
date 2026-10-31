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
 * That the request body editor is wired to the masked twin (#3137), which no
 * test above this file could see.
 *
 * The twin hangs off the editor's `onMount`, and `BodyPanel.test.tsx` stubs
 * `CodeEditor` as a `<div>` that never mounts one. This mock behaves as
 * `@monaco-editor/react` does where it matters: one editor, a model per `path`
 * that keeps the language it was created with until the `language` prop moves,
 * the path applied before the language, and the editor disposed on unmount. What
 * the worker's markers *say* is `lib/graphql/variables-diagnostics.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useRef } from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { templateTwinUri } from "@/lib/graphql/variables-diagnostics";
import { fieldResolverOf } from "@/test/variable-support";
import { RequestBuilderContext } from "../../../context";
import type { RequestBuilderContextValue, RequestState } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";
import { emptyDrafts } from "../../../utils/body-drafts";

interface StubModel {
	uri: { toString: () => string };
	language: string;
	value: string;
	disposed: boolean;
	getValue: () => string;
	setValue: (next: string) => void;
	getLanguageId: () => string;
	isDisposed: () => boolean;
	onDidChangeContent: () => { dispose: () => void };
	onWillDispose: () => { dispose: () => void };
	dispose: () => void;
}

const models = new Map<string, StubModel>();

function stubModel(uri: string, value: string, language: string): StubModel {
	const model: StubModel = {
		uri: { toString: () => uri },
		language,
		value,
		disposed: false,
		getValue: () => model.value,
		setValue: (next) => {
			model.value = next;
		},
		getLanguageId: () => model.language,
		isDisposed: () => model.disposed,
		onDidChangeContent: () => ({ dispose: () => {} }),
		onWillDispose: () => ({ dispose: () => {} }),
		dispose: () => {
			model.disposed = true;
		},
	};
	models.set(uri, model);
	return model;
}

const monacoStub = {
	Uri: { parse: (uri: string) => ({ toString: () => uri }) },
	editor: {
		createModel: (value: string, language: string, uri: { toString: () => string }) =>
			stubModel(uri.toString(), value, language),
		getModel: (uri: { toString: () => string }) => models.get(uri.toString()) ?? null,
		getModelMarkers: () => [],
		setModelMarkers: () => {},
		onDidChangeMarkers: () => ({ dispose: () => {} }),
	},
};

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({
		language,
		path,
		value,
		onMount,
	}: {
		language: string;
		path: string;
		value: string;
		onMount?: (editor: unknown, monaco: unknown) => void;
	}) => {
		const modelListeners = useRef<(() => void)[]>([]);
		const languageListeners = useRef<(() => void)[]>([]);
		const disposeListeners = useRef<(() => void)[]>([]);
		const current = useRef<StubModel | null>(null);
		const mounted = useRef(false);

		// The library reuses a model that already lives at the path, whatever
		// language it was last given, and creates one otherwise.
		const modelAt = () => models.get(path) ?? stubModel(path, value, language);

		useEffect(() => {
			const disposers = disposeListeners.current;
			current.current = modelAt();
			mounted.current = true;
			const editor = {
				getModel: () => current.current,
				onDidChangeModel: (fn: () => void) => modelListeners.current.push(fn),
				onDidChangeModelLanguage: (fn: () => void) => languageListeners.current.push(fn),
				onDidDispose: (fn: () => void) => disposers.push(fn),
			};
			onMount?.(editor, monacoStub);
			return () => {
				disposers.forEach((fn) => fn());
				mounted.current = false;
			};
			// Mount once, exactly as a real editor does.
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		// The path effect runs before the language effect, as in the library.
		useEffect(() => {
			if (!mounted.current) return;
			const next = modelAt();
			if (next === current.current) return;
			current.current = next;
			modelListeners.current.forEach((fn) => fn());
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [path]);

		useEffect(() => {
			if (!mounted.current || !current.current) return;
			if (current.current.language === language) return;
			current.current.language = language;
			languageListeners.current.forEach((fn) => fn());
		}, [language]);

		return <div data-testid="code-editor" data-language={language} />;
	},
}));
vi.mock("./body/GraphQLBody", () => ({ default: () => <div data-testid="graphql-body" /> }));
vi.mock("@/services/api", () => ({
	apiService: {
		getRequest: () => Promise.resolve({ id: "req_1", name: "x", collectionId: "c" }),
	},
}));

const { default: BodyPanel } = await import("./BodyPanel");

const BODY = '{"limit": {{n}}, "x": }';
const bodyUri = (id: string) => `inmemory://request/${id}/body`;
const twinOf = (id: string) => models.get(templateTwinUri(bodyUri(id)));

function panel(overrides: Partial<RequestState>) {
	const request = { ...createDefaultRequestState(), ...overrides };
	const resolve = (s: string) => s.replace(VARIABLE_PATTERN, (_m, n) => `resolved-${n}`);
	const value = {
		request,
		updateField: vi.fn(),
		getBodyDrafts: () => emptyDrafts(request.id),
		setBodyDrafts: () => {},
		getVariablesDraft: () => null,
		setVariablesDraft: () => {},
		resolveString: resolve,
		resolveField: fieldResolverOf(resolve),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	} as unknown as RequestBuilderContextValue;
	return (
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<RequestBuilderContext.Provider value={value}>
					<BodyPanel />
				</RequestBuilderContext.Provider>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => models.clear());
afterEach(cleanup);

describe("the request body's masked twin", () => {
	it.each(["json", "jsonrpc"] as const)("is attached in the %s mode", (bodyMode) => {
		render(panel({ id: "r1", bodyMode, body: BODY }));
		// The body's own text, with the token masked to a same-length string.
		expect(twinOf("r1")?.getValue()).toBe('{"limit": "VVV", "x": }');
	});

	it.each(["xml", "text"] as const)("is not attached in the %s mode", (bodyMode) => {
		render(panel({ id: "r1", bodyMode, body: BODY }));
		expect(twinOf("r1")).toBeUndefined();
	});

	it("moves to the next request's model when the request switches", () => {
		const view = render(panel({ id: "r1", bodyMode: "json", body: BODY }));
		const first = twinOf("r1");

		view.rerender(panel({ id: "r2", bodyMode: "json", body: '{"b": {{m}}}' }));

		expect(first?.isDisposed()).toBe(true);
		expect(twinOf("r2")?.getValue()).toBe('{"b": "VVV"}');
		expect(twinOf("r2")?.isDisposed()).toBe(false);
	});

	it("is dropped when the model's language stops being JSON, and returns with it", () => {
		const view = render(panel({ id: "r1", bodyMode: "json", body: BODY }));
		const json = twinOf("r1");

		// Same request, same model path: only the language of the model changes.
		view.rerender(panel({ id: "r1", bodyMode: "xml", body: BODY }));
		expect(json?.isDisposed()).toBe(true);

		view.rerender(panel({ id: "r1", bodyMode: "jsonrpc", body: BODY }));
		expect(twinOf("r1")?.isDisposed()).toBe(false);
	});

	it("is not attached when a request switch lands on a non-JSON model", () => {
		const view = render(panel({ id: "r1", bodyMode: "json", body: BODY }));
		const first = twinOf("r1");

		view.rerender(panel({ id: "r2", bodyMode: "xml", body: "<a>{{n}}</a>" }));

		expect(first?.isDisposed()).toBe(true);
		expect(twinOf("r2")).toBeUndefined();
	});

	it("is taken down when the panel unmounts", () => {
		const view = render(panel({ id: "r1", bodyMode: "json", body: BODY }));
		const twin = twinOf("r1");
		view.unmount();
		expect(twin?.isDisposed()).toBe(true);
	});

	it("is rebuilt around the editor the Source / Resolved swap tears down", () => {
		render(panel({ id: "r1", bodyMode: "json", body: BODY }));
		const source = twinOf("r1");

		fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
		expect(source?.isDisposed()).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Source" }));
		expect(twinOf("r1")?.isDisposed()).toBe(false);
	});
});

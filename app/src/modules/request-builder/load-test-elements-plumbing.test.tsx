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
 * `requestElements` and `elements` on the `startLoadTest` payload (issue
 * #1594) - both optional on `StartLoadTestRequest`, so nothing here fails a
 * type check if either is dropped from the `apiRequest` object literal in
 * `handleConfirmLoadTest`. Deleting the two lines that set them (`index.tsx`,
 * `requestElements,` and `elements: config.elements,`) left the rest of this
 * module's own suite green before this file existed - the exact silent
 * regression class `script-composition-plumbing.test.ts` guards on the
 * compose side, but nothing guarded on the `POST /runs` payload itself.
 *
 * Behavioural, not a scan: what matters is the resolved array and the chosen
 * override actually reaching the payload, not that some call mentions their
 * names.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { Collection, ElementDef, LoadTestConfig } from "@/types";
import type { RequestState } from "./types";

/** What the collection-ancestor query hands back; reset per test. */
let ancestors: Collection[] = [];

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const startLoadTest = vi.fn();

const requestQuery = {
	data: {
		id: "req_1",
		collectionId: "col_1",
		name: "Get user",
		method: "GET",
		url: "https://api.test/u",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		verifySSL: true,
		disableCookies: false,
		disabledSystemHeaders: [],
		disableUrlEncoding: false,
		stream: false,
	} as unknown,
	isLoading: false,
	isError: false,
	error: null as unknown,
	refetch: vi.fn(),
};

vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return {
		...actual,
		useRequestQuery: () => requestQuery,
		useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
		useCollectionAncestors: () => ancestors,
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest, executeRequest }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest, executeStreamRequest: vi.fn() },
	loadTestService: { startMonitoring: vi.fn() },
}));

let providerProps: Record<string, unknown> = {};
let dialogProps: Record<string, unknown> = {};

vi.mock("./context", () => ({
	RequestBuilderProvider: (props: Record<string, unknown>) => {
		providerProps = props;
		return null;
	},
}));
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => null }));
vi.mock("./components/LoadTestCommandSurface", () => ({ default: () => null }));
vi.mock("./components/SendRequestCommandSurface", () => ({ default: () => null }));
// Only whether it mounted and for which collection matters here; its own suite
// covers what the dialog does.
vi.mock("@/modules/collections/RunCollectionDialog", () => ({
	default: ({ collection }: { collection: Collection }) => (
		<div data-testid="run-collection-dialog" data-collection-id={collection.id} />
	),
}));
vi.mock("./components/LoadTestConfigDialog", () => ({
	default: (props: Record<string, unknown>) => {
		dialogProps = props;
		return <div data-testid="load-test-dialog" />;
	},
}));

const { default: RequestBuilder } = await import("./index");

const PRE_SCRIPT = { id: "el_pre", kind: "script.pre", enabled: true, config: { script: "1" } };

const REQUEST: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	method: "GET",
	url: "https://api.test/u",
	params: [],
	headers: [],
	disabledDefaultHeaders: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "none" },
	elements: [PRE_SCRIPT],
	followRedirects: true,
	maxRedirects: 10,
	timeout: null,
	httpVersion: "auto",
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	stream: false,
};

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

/** The body of the one startLoadTest call this test made. */
function startedPayload(): Record<string, unknown> {
	expect(startLoadTest).toHaveBeenCalledTimes(1);
	return startLoadTest.mock.calls[0][0] as Record<string, unknown>;
}

async function startLoadRun(config: LoadTestConfig, request: RequestState = REQUEST) {
	renderBuilder();
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(request);
	});
	await act(async () => {
		await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(config);
	});
}

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({
		method: "GET",
		url: "https://api.test/u",
		elements: [{ ...PRE_SCRIPT, origin: { kind: "request", scope: "request", id: "req_1" } }],
	});
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	startLoadTest.mockReset().mockResolvedValue({ runId: "run_1" });
	providerProps = {};
	dialogProps = {};
	ancestors = [];
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

describe("a load run sends the resolved chain as requestElements", () => {
	it("sends the elementsParts()-resolved chain under requestElements, not composed.elements", async () => {
		await startLoadRun(LOAD_CONFIG);

		const payload = startedPayload();
		expect(payload.requestElements).toEqual([
			{ ...PRE_SCRIPT, origin: { kind: "request", scope: "request", id: "req_1" } },
		]);
		// The composed payload's own `elements` (the resolved-chain shape
		// `POST /compose` answers under) must never survive under the run-level
		// `elements` key - that key is the timers/scripts override object, and
		// the two would collide if the spread's `elements` were left standing.
		expect(payload.elements).toBeUndefined();
	});

	it("sends the dialog's elements override under elements, distinct from requestElements", async () => {
		await startLoadRun({ ...LOAD_CONFIG, elements: { scripts: "allInline" } });

		const payload = startedPayload();
		expect(payload.elements).toEqual({ scripts: "allInline" });
		expect(payload.requestElements).toEqual([
			{ ...PRE_SCRIPT, origin: { kind: "request", scope: "request", id: "req_1" } },
		]);
	});
});

/**
 * `hasPostRequestScript` on the dialog: computed from the same resolved chain
 * the run composes, so an inherited collection script counts and a script
 * marked inline does not (the run runs it on every response, not on a sample).
 */
describe("the dialog's hasPostRequestScript", () => {
	const postScript = (config: Record<string, unknown>, id = "el_post"): ElementDef => ({
		id,
		kind: "script.post",
		enabled: true,
		config: { script: "pm.test('ok', () => {});", ...config },
	});

	async function dialogHasPostRequestScript(elements: ElementDef[]): Promise<unknown> {
		renderBuilder();
		await act(async () => {
			(providerProps.onStartLoadTest as (request: RequestState) => void)({
				...REQUEST,
				elements,
			});
		});
		expect(dialogProps).toHaveProperty("hasPostRequestScript");
		return dialogProps.hasPostRequestScript;
	}

	it("is true for a request whose only script is a post-request one", async () => {
		expect(await dialogHasPostRequestScript([postScript({})])).toBe(true);
	});

	it("is false when the post-request script is marked inline", async () => {
		expect(await dialogHasPostRequestScript([postScript({ inline: true })])).toBe(false);
	});

	it("is false for a request with only a pre-request script", async () => {
		expect(await dialogHasPostRequestScript([PRE_SCRIPT])).toBe(false);
	});

	it("is true for a post-request script inherited from a collection", async () => {
		ancestors = [
			{
				id: "col_1",
				name: "Col",
				description: "",
				order: 0,
				variables: {},
				auth: { mode: "none" },
				elements: [postScript({}, "el_inherited")],
				createdAt: "",
				updatedAt: "",
			},
		];
		expect(await dialogHasPostRequestScript([])).toBe(true);
	});
});

/**
 * A switched-off element stays off the run (#3050): the pipeline skips it, and
 * the engine would otherwise refuse the run over a scenario-only kind nobody is
 * using. Send and code generation still carry disabled elements; only this
 * payload filters.
 */
function collectionWith(
	id: string,
	name: string,
	elements: ElementDef[],
	parentId?: string
): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements,
		parentId,
		createdAt: "",
		updatedAt: "",
	} as Collection;
}

const pacing = (overrides: Partial<ElementDef> = {}, id = "el_pacing"): ElementDef => ({
	id,
	kind: "timer.pacing",
	enabled: true,
	config: { intervalMs: 1000 },
	...overrides,
});

describe("a disabled element is left out of requestElements (#3050)", () => {
	const sentIds = () =>
		(startedPayload().requestElements as ElementDef[] | undefined)?.map((el) => el.id);

	it("drops a disabled element on the request and keeps the enabled ones", async () => {
		await startLoadRun(LOAD_CONFIG, {
			...REQUEST,
			elements: [PRE_SCRIPT, pacing({ enabled: false })],
		});

		expect(sentIds()).toEqual(["el_pre"]);
	});

	it("drops a disabled element inherited from a collection", async () => {
		ancestors = [collectionWith("col_1", "Checkout", [pacing({ enabled: false })])];

		await startLoadRun(LOAD_CONFIG);

		expect(sentIds()).toEqual(["el_pre"]);
	});

	it("sends no requestElements at all when everything is disabled", async () => {
		await startLoadRun(LOAD_CONFIG, { ...REQUEST, elements: [pacing({ enabled: false })] });

		expect(startedPayload().requestElements).toBeUndefined();
	});

	it("sends no inherit.disable entry a collection level holds, and not the element it names (#3070)", async () => {
		const loop: ElementDef = { id: "el_loop", kind: "control.loop", enabled: true, config: {} };
		ancestors = [
			collectionWith("col_root", "Root", [loop]),
			collectionWith(
				"col_1",
				"Folder",
				[
					{
						id: "el_suppress",
						kind: "inherit.disable",
						enabled: true,
						config: { elementId: "el_loop" },
					},
				],
				"col_root"
			),
		];

		await startLoadRun(LOAD_CONFIG);

		expect(sentIds()).toEqual(["el_pre"]);
	});

	it("drops a collection's setup and teardown scripts and keeps its other elements (#3070)", async () => {
		const assertStatus: ElementDef = {
			id: "el_assert",
			kind: "assert.status",
			enabled: true,
			config: { range: "2xx" },
		};
		ancestors = [
			collectionWith("col_1", "Checkout", [
				{ id: "el_setup", kind: "script.setup", enabled: true, config: { script: "1" } },
				{
					id: "el_teardown",
					kind: "script.teardown",
					enabled: true,
					config: { script: "2" },
				},
				assertStatus,
			]),
		];

		await startLoadRun(LOAD_CONFIG);

		expect(sentIds()).toEqual(["el_assert", "el_pre"]);
	});

	it("still sends an enabled element of the same kind, for the dialog to have blocked", async () => {
		await startLoadRun(LOAD_CONFIG, { ...REQUEST, elements: [pacing()] });

		expect(sentIds()).toEqual(["el_pacing"]);
	});
});

describe("the dialog's scenarioOnlyElements (#3050)", () => {
	async function openDialog(elements: ElementDef[]) {
		renderBuilder();
		await act(async () => {
			(providerProps.onStartLoadTest as (request: RequestState) => void)({
				...REQUEST,
				elements,
			});
		});
		return dialogProps.scenarioOnlyElements as { id: string; origin?: { name?: string } }[];
	}

	it("lists an enabled one on the request, with its origin", async () => {
		const listed = await openDialog([pacing()]);

		expect(listed.map((el) => el.id)).toEqual(["el_pacing"]);
	});

	it("lists an enabled one inherited from a collection, naming the collection", async () => {
		ancestors = [collectionWith("col_1", "Checkout", [pacing()])];

		const listed = await openDialog([]);

		expect(listed.map((el) => [el.id, el.origin?.name])).toEqual([["el_pacing", "Checkout"]]);
	});

	it("leaves out a disabled one, on the request or inherited", async () => {
		ancestors = [collectionWith("col_1", "Checkout", [pacing({ enabled: false }, "el_a")])];

		expect(await openDialog([pacing({ enabled: false }, "el_b")])).toEqual([]);
	});

	it("leaves out one the request suppresses with inherit.disable", async () => {
		ancestors = [collectionWith("col_1", "Checkout", [pacing()])];
		const suppress: ElementDef = {
			id: "el_suppress",
			kind: "inherit.disable",
			enabled: true,
			config: { elementId: "el_pacing" },
		};

		expect(await openDialog([suppress])).toEqual([]);
	});

	it("leaves out a root control.loop that a folder's inherit.disable names (#3070)", async () => {
		const loop: ElementDef = { id: "el_loop", kind: "control.loop", enabled: true, config: {} };
		const suppress: ElementDef = {
			id: "el_suppress",
			kind: "inherit.disable",
			enabled: true,
			config: { elementId: "el_loop" },
		};
		ancestors = [
			collectionWith("col_root", "Root", [loop]),
			collectionWith("col_1", "Folder", [suppress], "col_root"),
		];

		expect(await openDialog([])).toEqual([]);
	});
});

describe("Run collection hand-over (#3050)", () => {
	async function openDialogFor(chain: Collection[]) {
		ancestors = chain;
		renderBuilder();
		await act(async () => {
			(providerProps.onStartLoadTest as (request: RequestState) => void)(REQUEST);
		});
	}

	it("hands over to the collection-run dialog for the request's own collection", async () => {
		await openDialogFor([
			collectionWith("col_root", "Root", []),
			collectionWith("col_1", "Checkout", [pacing()], "col_root"),
		]);
		expect(screen.getByTestId("load-test-dialog")).toBeInTheDocument();
		expect(screen.queryByTestId("run-collection-dialog")).toBeNull();

		await act(async () => {
			(dialogProps.onRunCollection as () => void)();
		});

		expect(screen.queryByTestId("load-test-dialog")).toBeNull();
		expect(screen.getByTestId("run-collection-dialog")).toHaveAttribute(
			"data-collection-id",
			"col_1"
		);
	});

	it("offers no way out when the request's collection did not resolve", async () => {
		await openDialogFor([]);

		expect(dialogProps.onRunCollection).toBeUndefined();
	});
});

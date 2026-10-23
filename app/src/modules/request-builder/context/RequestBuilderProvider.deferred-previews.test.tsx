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
 * The two resolved views that print a value, and a name a pre-request script
 * sets at send (#2762): the key/value rows' sigma peek and the Body tab's
 * Resolved pane. `POST /compose` leaves such a name written and lists it in
 * `deferredVariables` (#2521); a view that printed the stored value instead
 * showed a request the send never makes.
 *
 * Driven through the real provider because the wiring is the claim: the provider
 * is the one place that hands `resolveField` down, so every table behind
 * `useVariableSupport` (Headers, Params, path variables, form-data, urlencoded,
 * OAuth2) and the Body pane are covered by what it hands them. The renderer
 * holds no rule for which requests are scripted, so each case varies only the
 * engine's answer.
 *
 * Mutation check: have the provider hand down `resolveStoredField` in place of
 * the wrapped `resolveField`, and the peek, the Body pane and the picked-row
 * cases redden.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactNode } from "react";
import {
	render,
	renderHook,
	screen,
	cleanup,
	waitFor,
	fireEvent,
	act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { bindDataFile } from "@/test/file-bindings.testkit";
import type { KeyValueItem } from "@/types";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

const COLLECTION_ID = "col-users";
const globals = {
	variables: {
		token: { value: "stored-token", enabled: true },
		host: { value: "api.test", enabled: true },
	},
};
const collections = [
	{
		id: COLLECTION_ID,
		name: "Users",
		dataSchema: { columns: ["name"] },
		variables: {},
	},
];
// A constant, not a fresh `[]` per call: the resolver's identity is a claim below.
const environments: unknown[] = [];
const session = { activeEnvironmentId: "env_1" as string | null };

// Monaco does not run in jsdom and the GraphQL pane is not what this guards.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));
vi.mock("../components/RequestTabs/panels/body/GraphQLBody", () => ({
	default: () => <div data-testid="graphql-body" />,
}));
vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useCollectionAncestors: () => [],
	useEnvironmentsQuery: () => ({ data: environments }),
	useRequestDefaultsQuery: () => ({ data: undefined }),
	useRequestQuery: () => ({ data: undefined }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: null, report: null, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: (selector: (s: typeof session) => unknown) => selector(session),
	useResponseStore: (
		selector: (s: { getResponse: () => null; setResponse: ReturnType<typeof vi.fn> }) => unknown
	) => selector({ getResponse: () => null, setResponse: vi.fn() }),
}));
vi.mock("@/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks")>();
	return { ...actual, useSaveManager: () => ({ saveStatus: "idle", isSaving: false }) };
});

const { default: RequestBuilderProvider } = await import("./RequestBuilderProvider");
const { useRequestBuilderContext } = await import("./RequestBuilderContext");
const { useVariableSupport } = await import("../hooks/useVariableSupport");
const { default: BodyPanel } = await import("../components/RequestTabs/panels/BodyPanel");
const { useDataFileStore, useBoundRowStore } = await import("@/stores");

const NOTE = "{{token}} is set by a pre-request script at send.";
/** Carries a token, so the builder asks the engine what a script defers. */
const URL_WITH_TOKEN = "https://x.test/?t={{token}}";

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function builder(client: QueryClient, initial: Record<string, unknown>, children: ReactNode) {
	return (
		<QueryClientProvider client={client}>
			<TooltipProvider delayDuration={0}>
				<RequestBuilderProvider
					initialRequest={{ id: "req_1", url: URL_WITH_TOKEN, ...initial }}
					collectionId={COLLECTION_ID}
				>
					{children}
				</RequestBuilderProvider>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const row = (id: string, key: string, value: string): KeyValueItem => ({
	id,
	key,
	value,
	enabled: true,
});

/** A header table over the builder's own variable support, as HeadersPanel mounts one. */
function Headers({ items }: { items: KeyValueItem[] }) {
	const variables = useVariableSupport();
	return (
		<KeyValueEditor
			items={items}
			onChange={() => {}}
			keyPlaceholder="Header"
			valuePlaceholder="Value"
			showResolved={true}
			allowDisable={true}
			variables={variables}
			fieldContext="header"
		/>
	);
}

/** Open the sigma peek of the row named @p key; what it says is read by `peekText`. */
function openPeek(key: string) {
	fireEvent.pointerMove(screen.getByRole("button", { name: `Resolved value of ${key}` }), {
		pointerType: "mouse",
	});
}

const peekText = async () => (await screen.findByRole("tooltip")).textContent ?? "";

/** Waits until the engine has been asked, which is when the answer is on its way. */
async function composed() {
	await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
	composeRequest.mockReset();
	session.activeEnvironmentId = "env_1";
});

afterEach(cleanup);

describe("a header row's sigma peek and a name a pre-request script sets", () => {
	const AUTH = row("h1", "Authorization", "Bearer {{token}}");
	const HOST = row("h2", "X-Host", "{{host}}");

	it("keeps the token written and says a script sets it", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder(newClient(), {}, <Headers items={[AUTH]} />));

		openPeek("Authorization");
		// The row resolved nothing, and still has its sigma: the sentence is the
		// peek's whole content. Until the engine answers the stored value shows.
		await waitFor(async () => expect(await peekText()).toContain(NOTE));
		const text = await peekText();
		expect(text).toContain("Authorization: Bearer {{token}}");
		expect(text).not.toContain("stored-token");
	});

	it("resolves a row that names another variable, with no sentence", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder(newClient(), {}, <Headers items={[AUTH, HOST]} />));
		await composed();

		openPeek("X-Host");
		const text = await peekText();
		expect(text).toContain("X-Host: api.test");
		expect(text).not.toContain("pre-request script");
	});

	it("is the peek it always was when the engine deferred nothing", async () => {
		composeRequest.mockResolvedValue({});
		render(builder(newClient(), {}, <Headers items={[AUTH]} />));
		await composed();

		openPeek("Authorization");
		const text = await peekText();
		expect(text).toContain("Authorization: Bearer stored-token");
		expect(text).not.toContain("pre-request script");
	});

	it("has no sigma on a literal row, deferred names or not", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder(newClient(), {}, <Headers items={[AUTH, row("h3", "Accept", "json")]} />));
		await composed();

		expect(
			screen.getByRole("button", { name: "Resolved value of Authorization" })
		).toBeVisible();
		expect(screen.queryByRole("button", { name: "Resolved value of Accept" })).toBeNull();
	});
});

describe("the sigma peek of a row holding a dynamic variable beside a deferred name", () => {
	const TRACE = row("trace", "X-Trace", "id-{{$randomInt}}-{{token}}");

	function Tab({ items }: { items: KeyValueItem[] }) {
		const [shown, setShown] = useState(true);
		return (
			<>
				<button onClick={() => setShown((was) => !was)}>Switch tab</button>
				{shown && <Headers items={items} />}
			</>
		);
	}

	it("says the same thing after a re-render and after a tab round trip", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		const client = newClient();
		const tab = () => builder(client, {}, <Tab items={[TRACE]} />);
		const { rerender } = render(tab());

		openPeek("X-Trace");
		await waitFor(async () => expect(await peekText()).toContain(NOTE));
		const before = await peekText();
		expect(before).toMatch(/X-Trace: id-\d+-\{\{token\}\}/);

		rerender(tab());
		// Params -> Headers -> Params: the rows are new instances, the builder's
		// resolver is the one they had.
		fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));
		fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));
		openPeek("X-Trace");
		expect(await peekText()).toBe(before);
	});
});

describe("the Body tab's Resolved pane and a name a pre-request script sets", () => {
	const BODY = '{"t":"{{token}}","h":"{{host}}"}';

	function resolvedPane(): string {
		fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
		return document.querySelector("pre")?.textContent ?? "";
	}

	it("leaves the name written, resolves the rest and says a script sets it", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder(newClient(), { bodyMode: "json", body: BODY }, <BodyPanel />));

		resolvedPane();
		expect(await screen.findByText(NOTE)).toBeInTheDocument();
		expect(document.querySelector("pre")?.textContent).toBe('{"t":"{{token}}","h":"api.test"}');
	});

	it("is the pane it always was when the engine deferred nothing", async () => {
		composeRequest.mockResolvedValue({});
		render(builder(newClient(), { bodyMode: "json", body: BODY }, <BodyPanel />));
		await composed();

		expect(resolvedPane()).toBe('{"t":"stored-token","h":"api.test"}');
		expect(screen.queryByText(/pre-request script/)).toBeNull();
	});

	it("says nothing about a deferred name the body never uses", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["other"] });
		render(builder(newClient(), { bodyMode: "json", body: BODY }, <BodyPanel />));
		await composed();

		expect(resolvedPane()).toBe('{"t":"stored-token","h":"api.test"}');
		expect(screen.queryByText(/pre-request script/)).toBeNull();
	});

	it("says nothing under the Source view", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder(newClient(), { bodyMode: "json", body: BODY }, <BodyPanel />));
		await composed();

		expect(screen.queryByText(/pre-request script/)).toBeNull();
	});
});

describe("a picked data row beside a name a pre-request script sets", () => {
	/** One row whose cell holds a quote, which a JSON string must escape. */
	const CSV = 'name\n"say ""hi"""\n';

	beforeEach(() => {
		useDataFileStore.setState({ locations: {} });
		bindDataFile(COLLECTION_ID, { path: "/data/users.csv", fileName: "users.csv" });
		Object.defineProperty(window, "electronAPI", {
			value: {
				readDataFile: vi.fn(async () => ({
					bytes: new TextEncoder().encode(CSV),
					fileName: "users.csv",
				})),
			},
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		useBoundRowStore.setState({ bound: null });
		useDataFileStore.setState({ locations: {} });
		Reflect.deleteProperty(window, "electronAPI");
	});

	function setup() {
		const client = newClient();
		return renderHook(() => useRequestBuilderContext(), {
			wrapper: ({ children }) => builder(client, {}, children),
		});
	}

	it("still escapes the cell by the text around the token it stands beside", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		const { result } = setup();
		await waitFor(() => expect(result.current.deferredVariables).toEqual(["token"]));
		act(() => result.current.sendWithRow.load());
		await waitFor(() => expect(result.current.sendWithRow.status).toBe("ready"));
		act(() => result.current.rememberRowIndex(0));

		// The cell after the token sits inside the string the token opened in, so
		// it is escaped; a field resolved in pieces around the token would have
		// forgotten the opening quote and written it raw.
		const bound = result.current.resolveField(
			'{"a":"{{token}}","b":"x {{ token }} {{data.name}}","c":"{{data.name}}"}',
			"json"
		);
		expect(bound.text).toBe(
			'{"a":"{{token}}","b":"x {{ token }} say \\"hi\\"","c":"say \\"hi\\""}'
		);
		expect(bound.refusals).toEqual([]);
	});
});

describe("the field resolver the builder hands down", () => {
	it("keeps one identity while the names and the variables do not move", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		const client = newClient();
		const { result, rerender } = renderHook(() => useRequestBuilderContext(), {
			wrapper: ({ children }) => builder(client, {}, children),
		});
		await waitFor(() => expect(result.current.deferredVariables).toEqual(["token"]));

		const before = result.current.resolveField;
		rerender();
		expect(result.current.resolveField).toBe(before);
	});
});

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
 * The preview and the send agreeing about a bound data row (issue #1062).
 *
 * #1007 wired the *payload* side of a Send-with-row - `composeForSend` sends
 * the row's column names on `POST /compose`, so the engine defers a bare
 * `{{username}}` and binds it from the row - and left the preview resolving
 * with no row at all. The URL bar, the params and body previews and the
 * resolved auth therefore showed the environment's value for a name the send
 * answers from the file: a resolved token carrying a value the engine will
 * never send, reached through the bare spelling.
 *
 * Driven through the real provider rather than a stub, because what is being
 * checked is precisely the wiring between three things the provider is the only
 * place to hold together: the picked row, the resolver, and the per-request
 * memory of which row that is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const globals = { variables: {} as Record<string, unknown> };
const collections: Array<Record<string, unknown>> = [];
const environments: Array<Record<string, unknown>> = [];
const session = { activeEnvironmentId: null as string | null };

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: collections }),
	useCollectionAncestors: () => [],
	useEnvironmentsQuery: () => ({ data: environments }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: null, report: null, isLoading: false }),
	// The row cap Send-with-row measures the declared file against; empty
	// entries leave it on the seeds, which no case here comes near.
	useConfigQuery: () => ({ data: { entries: [] } }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: () => session,
	useResponseStore: () => ({ getResponse: () => null, setResponse: vi.fn() }),
}));
vi.mock("@/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/hooks")>();
	return { ...actual, useSaveManager: () => ({ saveStatus: "idle", isSaving: false }) };
});

const { useDataFileStore } = await import("@/stores");
const { default: RequestBuilderProvider } = await import("./RequestBuilderProvider");
const { useRequestBuilderContext } = await import("./RequestBuilderContext");

const COLLECTION_ID = "col-users";
/** A row whose column names collide with the environment on purpose. */
const CSV = "username,email\nada,ada@example.test\ngrace,grace@example.test\n";

/** A collection declaring the contract, which is what puts columns in scope. */
function declaringCollection() {
	return {
		id: COLLECTION_ID,
		name: "Users",
		dataSchema: { columns: ["username", "email"] },
		variables: {},
	};
}

/** The read IPC, answering with the CSV above. */
function stubReadDataFile(text = CSV) {
	const readDataFile = vi.fn(async () => ({
		bytes: new TextEncoder().encode(text),
		fileName: "users.csv",
	}));
	Object.defineProperty(window, "electronAPI", {
		value: { readDataFile },
		configurable: true,
		writable: true,
	});
	return readDataFile;
}

function setup(requestId: string | null = "req_a") {
	return renderHook(() => useRequestBuilderContext(), {
		wrapper: ({ children }) => (
			<RequestBuilderProvider collectionId={COLLECTION_ID} initialRequest={{ id: requestId }}>
				{children}
			</RequestBuilderProvider>
		),
	});
}

/** Read the declared file and pick one row, as the picker does. */
async function bindRow(
	result: { current: ReturnType<typeof useRequestBuilderContext> },
	index: number
) {
	act(() => result.current.sendWithRow.load());
	await waitFor(() => expect(result.current.sendWithRow.status).toBe("ready"));
	act(() => result.current.rememberRowIndex(index));
}

beforeEach(() => {
	vi.clearAllMocks();
	globals.variables = {};
	collections.length = 0;
	collections.push(declaringCollection());
	environments.length = 0;
	environments.push({
		id: "env",
		name: "Staging",
		// The collision the tier order exists for: the environment defines the
		// same name the dataset declares as a column.
		variables: { username: { value: "from-the-environment", enabled: true } },
	});
	session.activeEnvironmentId = "env";
	useDataFileStore.setState({ locations: {} });
	useDataFileStore
		.getState()
		.setDataFile(COLLECTION_ID, { path: "/data/users.csv", fileName: "users.csv" });
	stubReadDataFile();
});

afterEach(() => {
	useDataFileStore.setState({ locations: {} });
	Reflect.deleteProperty(window, "electronAPI");
});

describe("the preview while a row is bound", () => {
	it("answers a bare column from the row rather than from the environment", async () => {
		const { result } = setup();
		// Before a row is picked the preview is composition's, and the
		// environment answers - which is correct for a Send with no row.
		expect(result.current.resolveString("https://api.test/u/{{username}}")).toBe(
			"https://api.test/u/from-the-environment"
		);

		await bindRow(result, 0);

		expect(result.current.resolveString("https://api.test/u/{{username}}")).toBe(
			"https://api.test/u/ada"
		);
	});

	it("gives the bare spelling and {{data.column}} the same answer", async () => {
		// They are one bind, so a preview that answered them differently would be
		// telling two stories about a single substitution.
		const { result } = setup();
		await bindRow(result, 1);
		expect(result.current.resolveString("{{username}}|{{data.username}}")).toBe("grace|grace");
	});

	it("reaches the resolved-auth preview, which goes through resolveObject", async () => {
		// A credential is the canonical data-driven field (issue #591), so the
		// auth preview is the one that most needs the row - and it is resolved
		// object-wise rather than string-wise, which is a second call site.
		const { result } = setup();
		act(() =>
			result.current.setRequest({
				...result.current.request,
				auth: { mode: "bearer", token: "{{email}}" },
			})
		);
		await bindRow(result, 0);
		expect(result.current.resolvedAuth).toMatchObject({ token: "ada@example.test" });
	});

	it("leaves every other name resolving exactly as it did", async () => {
		const { result } = setup();
		await bindRow(result, 0);
		// A name the row does not carry is an ordinary variable, not a mistake
		// about a column.
		expect(result.current.resolveString("{{nowhere}}")).toBe("{{nowhere}}");
	});
});

describe("which row the preview is bound to", () => {
	it("is none until the declared file has actually been read", () => {
		// A "Repro row N" navigation (issue #730) sets the index before the picker
		// has ever opened, so an index alone must not bind a preview.
		const { result } = setup();
		act(() => result.current.rememberRowIndex(1));
		expect(result.current.resolveString("{{username}}")).toBe("from-the-environment");
	});

	it("is remembered per request, not per builder", async () => {
		// One provider serves every request tab (`Shell` renders the builder at
		// the same position), so a single number followed the user from one
		// request to the next before issue #659 keyed it.
		const { result, rerender } = setup("req_a");
		await bindRow(result, 1);
		expect(result.current.resolveString("{{username}}")).toBe("grace");

		act(() => result.current.setRequest({ ...result.current.request, id: "req_b" }));
		expect(result.current.resolveString("{{username}}")).toBe("from-the-environment");

		act(() => result.current.setRequest({ ...result.current.request, id: "req_a" }));
		rerender();
		expect(result.current.resolveString("{{username}}")).toBe("grace");
	});
});

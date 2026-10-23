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
 * A name a pre-request script sets at send is not painted as its stored value
 * (#2741), on both painters: the single-line fields (`VariableInput`) and the
 * editors' decorations (`EditorVariableTokens`). The builder asks the engine
 * once, for the request it holds, and only while that request has a
 * `{{token}}`; the renderer holds no rule for which requests are scripted, so
 * every case varies only the engine's answer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import VariableInput from "@/components/shared/VariableInput";
import { useEditorVariableTokensContext } from "@/components/shared/EditorVariableTokens/context";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

const globals = { variables: { token: { value: "stored-token", enabled: true } } };
const session = { activeEnvironmentId: "env_1" as string | null };

vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: globals }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useEnvironmentsQuery: () => ({ data: [] }),
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
const { useVariableSupport } = await import("../hooks/useVariableSupport");

/** What each painter says about `{{token}}`, read where the painters read it. */
function Painters({ value }: { value: string }) {
	const variables = useVariableSupport();
	const tokens = useEditorVariableTokensContext();
	return (
		<>
			<VariableInput value={value} onChange={() => {}} variables={variables} />
			<output data-testid="editor-state">{tokens?.classify("token").state}</output>
		</>
	);
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function builder(url: string, id: string, client: QueryClient) {
	return (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RequestBuilderProvider initialRequest={{ id, url }} collectionId={null}>
					<Painters value={url} />
				</RequestBuilderProvider>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** The classes of the `{{token}}` the single-line field draws. */
function fieldTokenClass(): string {
	return screen.getByText("{{token}}").parentElement?.className ?? "";
}

beforeEach(() => {
	composeRequest.mockReset();
	session.activeEnvironmentId = "env_1";
});

afterEach(cleanup);

describe("the builder's token painters and a name a pre-request script sets", () => {
	it("stop painting it as resolved, in the fields and in the editors", async () => {
		composeRequest.mockResolvedValue({ deferredVariables: ["token"] });
		render(builder("https://x.test/?t={{token}}", "req_1", newClient()));

		await waitFor(() =>
			expect(screen.getByTestId("editor-state")).toHaveTextContent("deferred")
		);
		expect(fieldTokenClass()).toContain("decoration-dashed");
		expect(fieldTokenClass()).not.toContain("text-primary");
	});

	it("paint it as resolved when the engine deferred nothing", async () => {
		composeRequest.mockResolvedValue({});
		render(builder("https://x.test/?t={{token}}", "req_1", newClient()));

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		expect(screen.getByTestId("editor-state")).toHaveTextContent("resolved");
		expect(fieldTokenClass()).toContain("text-primary");
		expect(fieldTokenClass()).not.toContain("decoration-dashed");
	});

	it("paint it as resolved while the engine has not answered", () => {
		composeRequest.mockReturnValue(new Promise(() => {}));
		render(builder("https://x.test/?t={{token}}", "req_1", newClient()));

		expect(screen.getByTestId("editor-state")).toHaveTextContent("resolved");
		expect(fieldTokenClass()).toContain("text-primary");
	});

	it("do not ask the engine about a request with no token", async () => {
		composeRequest.mockResolvedValue({});
		render(builder("https://x.test/?page=1", "req_literal", newClient()));
		// A request that does ask, as the control: a call is observable, and the
		// literal one's absence is then read against it, not against a delay.
		render(builder("https://x.test/?t={{token}}", "req_tokened", newClient()));

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		expect(composeRequest).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req_tokened" })
		);
	});
});

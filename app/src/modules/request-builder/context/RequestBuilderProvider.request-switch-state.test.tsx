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
 * State a panel holds for itself must not follow the user to another request
 * (#3666).
 *
 * `Shell.tsx` reuses one `RequestBuilderProvider` for every request tab, so the
 * builder is not remounted on a switch: only `initialRequest` changes. A panel
 * whose state is its own therefore survived the switch and showed - or, for a
 * bulk-edit draft, committed into - the next request. `RequestTabs` keys its
 * mount-on-demand panels on the builder's `memoryKey`; Body, force-mounted so
 * Monaco survives a tab glance, resets its two pieces of view state itself.
 *
 * The real provider, `RequestTabs` and panels, re-rendered with a second request
 * exactly as the Shell does. Only the data hooks are stubbed.
 *
 * Mutation check: drop `key={memoryKey}` from `ParamsPanel` and "never shows the
 * first request's bulk-edit text" and "leaves the second request unchanged" go
 * red; drop it from `AuthPanel` and the reveal case goes red; drop the
 * `stateFor` reset in `BodyPanel` and the notice case goes red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { TestQueryClient } from "@/test/TestQueryClient";
import { TooltipProvider } from "@/components/ui";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import RequestTabs from "../components/RequestTabs";
import { fieldResolverOf } from "@/test/variable-support";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { RequestState } from "../types";

vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveField: fieldResolverOf((s: string) => s),
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
	useRequestQuery: () => ({ data: undefined }),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

// Monaco does not run in jsdom, and the editor is not what is guarded here.
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const row = (id: string, key: string, value: string) => ({
	id,
	key,
	value,
	enabled: true,
});

const REQUEST_A: Partial<RequestState> = {
	id: "req_a",
	name: "A",
	url: "https://a.test/x?a=1",
	params: [row("a1", "a", "1")],
	auth: { mode: "bearer", token: "token-of-a" },
};
const REQUEST_B: Partial<RequestState> = {
	id: "req_b",
	name: "B",
	url: "https://b.test/y?b=2",
	params: [row("b1", "b", "2")],
	auth: { mode: "bearer", token: "token-of-b" },
};

/** What the builder holds, drawn so the test reads it from the DOM. */
function Probe() {
	const { request, activeTab, hasUnsavedChanges } = useRequestBuilderContext();
	return (
		<dl>
			<dd data-testid="id">{request.id}</dd>
			<dd data-testid="url">{request.url}</dd>
			<dd data-testid="param-keys">{request.params.map((p) => p.key).join(",")}</dd>
			<dd data-testid="dirty">{String(hasUnsavedChanges)}</dd>
			<dd data-testid="active-tab">{activeTab}</dd>
		</dl>
	);
}
const probed = (testId: string) => screen.getByTestId(testId).textContent;

function Harness({ initialRequest }: { initialRequest: Partial<RequestState> }) {
	return (
		<TestQueryClient>
			<TooltipProvider>
				<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
					<Probe />
					<RequestTabs />
				</RequestBuilderProvider>
			</TooltipProvider>
		</TestQueryClient>
	);
}

/** Radix activates a trigger on `mousedown`; `click` alone never switches. */
const openTab = (name: RegExp) => {
	fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
	expect(screen.getByRole("tab", { name })).toHaveAttribute("data-state", "active");
};

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
});

describe("a bulk edit open in one request", () => {
	it("never shows the first request's text after a switch to the second", () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		fireEvent.click(screen.getByRole("radio", { name: /Bulk edit/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "Query parameters" }), {
			target: { value: "a=1\nsecretA=zzz" },
		});

		rerender(<Harness initialRequest={REQUEST_B} />);

		expect(screen.queryByRole("textbox", { name: "Query parameters" })).toBeNull();
		expect(screen.getByRole("radio", { name: /Table/ })).toBeChecked();
	});

	it("leaves the second request's params and url unchanged", () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		fireEvent.click(screen.getByRole("radio", { name: /Bulk edit/ }));
		fireEvent.change(screen.getByRole("textbox", { name: "Query parameters" }), {
			target: { value: "a=1\nsecretA=zzz" },
		});

		rerender(<Harness initialRequest={REQUEST_B} />);
		// The control that used to commit A's draft into B.
		fireEvent.click(screen.getByRole("radio", { name: /Bulk edit/ }));
		fireEvent.click(screen.getByRole("radio", { name: /Table/ }));

		expect(probed("id")).toBe("req_b");
		expect(probed("param-keys")).toBe("b");
		expect(probed("url")).toBe("https://b.test/y?b=2");
		expect(probed("dirty")).toBe("false");
	});
});

describe("a secret revealed in one request", () => {
	it("is masked again after a switch to a second request on the same auth mode", () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		openTab(/^Auth/);
		const tokenField = () => screen.getByLabelText("Token");
		expect(tokenField()).toHaveAttribute("type", "password");

		fireEvent.click(screen.getByRole("button", { name: "Show value" }));
		expect(tokenField()).toHaveAttribute("type", "text");

		// The Shell restores each request's own sub-tab; B was last on Auth too.
		act(() => useTabSelectionStore.getState().setRequestTab("req_b", "auth"));
		rerender(<Harness initialRequest={REQUEST_B} />);

		expect(probed("active-tab")).toBe("auth");
		expect(tokenField()).toHaveValue("token-of-b");
		expect(tokenField()).toHaveAttribute("type", "password");
	});
});

describe("the Content-Type notice", () => {
	it("does not follow a request switch", async () => {
		const { rerender } = render(<Harness initialRequest={REQUEST_A} />);
		openTab(/^Body/);
		fireEvent.click(screen.getByRole("combobox", { name: "Body type" }));
		fireEvent.click(await screen.findByRole("option", { name: "JSON" }));
		expect(screen.getByText(/Added/)).toBeInTheDocument();

		act(() => useTabSelectionStore.getState().setRequestTab("req_b", "body"));
		rerender(<Harness initialRequest={REQUEST_B} />);

		expect(probed("active-tab")).toBe("body");
		expect(within(screen.getByRole("tabpanel")).queryByText(/Added/)).toBeNull();
	});
});

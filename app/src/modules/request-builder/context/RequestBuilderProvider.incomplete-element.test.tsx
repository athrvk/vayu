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
 * Issue #1635 / #3048: `buildUpdatePayload` sends the whole `elements` array
 * whenever it is touched, and the engine 400s the *entire* payload on one
 * element it refuses - a fresh element missing a required key, or a value the
 * schema rejects. `RequestBuilderProvider`'s `handleSave` (the function it
 * hands `useSaveManager` as `onSave`) holds back the list alone: every other
 * touched field is still sent, and the list goes out once it is valid.
 * `buildUpdatePayload` writes `elements` only when the field set it is handed
 * carries it, so the field set is what these cases read.
 *
 * Mutation checks: restore the old throw-before-`onSave` (any touched field)
 * and the "saves the URL and header edits" cases redden; send `changedFields`
 * instead of the reduced set and the "no `elements`" assertions redden.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { render, screen, act, cleanup } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { SaveBlockedError } from "@/lib/elements";
import type { RequestState, MergeableRequestField } from "../types";
import type { ElementConfigSchema, ElementKindSchema } from "@/types";

type OnSave = (
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
) => Promise<void>;

/** The options the provider handed the save manager on the last render. */
let managerOptions: { onSave: () => Promise<void>; hasChanges: boolean; changeToken: number };

const kind = (
	name: string,
	configSchema: Omit<ElementConfigSchema, "type">
): ElementKindSchema => ({
	kind: name,
	version: 1,
	label: name,
	description: "",
	category: "extract",
	hotPathClass: "declarative",
	collectionOnly: false,
	configSchema: { type: "object", ...configSchema },
	phases: [],
});

/** The constraints the cases below break, transcribed from the engine catalogue. */
const KINDS: ElementKindSchema[] = [
	kind("extract.json", {
		required: ["path", "variable"],
		properties: { path: { type: "string" }, variable: { type: "string", minLength: 1 } },
	}),
	kind("timer.pacing", {
		required: ["everyMs"],
		properties: { everyMs: { type: "integer", minimum: 1 } },
	}),
	kind("timer.throughput", {
		required: ["targetPerMinute"],
		properties: { targetPerMinute: { type: "number", exclusiveMinimum: 0 } },
	}),
	kind("control.throughput", {
		properties: {
			percent: { type: "number", minimum: 0, maximum: 100 },
			everyN: { type: "integer", minimum: 1 },
		},
	}),
	kind("control.loop", {
		required: ["count"],
		properties: { count: { type: "integer", minimum: 1 } },
	}),
	kind("control.if", {
		required: ["condition"],
		properties: {
			condition: { type: "string", pattern: "^\\s*\\{\\{[^}]+\\}\\}\\s*(==|!=)\\s*\\S.*$" },
		},
	}),
	kind("assert.status", {
		properties: {
			in: { type: "array" },
			range: {
				type: "object",
				required: ["min", "max"],
				properties: { min: { type: "integer" }, max: { type: "integer" } },
			},
		},
	}),
];

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: (options: {
		onSave: () => Promise<void>;
		hasChanges: boolean;
		changeToken: number;
	}) => {
		managerOptions = options;
		return { forceSave: vi.fn(), status: "idle", isSaving: false };
	},
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
	useElementKindsQuery: () => ({ data: KINDS }),
}));

interface InvalidCase {
	kind: string;
	invalid: Record<string, unknown>;
	valid: Record<string, unknown>;
}

/** Every class of value the save holds back: an absent key, a missing operand, a refused value. */
const CASES: [string, InvalidCase][] = [
	[
		"a fresh element missing a required key",
		{ kind: "extract.json", invalid: {}, valid: { path: "$.a", variable: "token" } },
	],
	[
		"a status assertion with no codes or range (#3043)",
		{ kind: "assert.status", invalid: {}, valid: { in: [200] } },
	],
	[
		"a cleared required text field",
		{
			kind: "extract.json",
			invalid: { path: "$.a", variable: "" },
			valid: { path: "$.a", variable: "token" },
		},
	],
	["a cadence of 0", { kind: "timer.pacing", invalid: { everyMs: 0 }, valid: { everyMs: 1000 } }],
	[
		"a percent of 150",
		{ kind: "control.throughput", invalid: { percent: 150 }, valid: { percent: 50 } },
	],
	["a repeat count of 0", { kind: "control.loop", invalid: { count: 0 }, valid: { count: 3 } }],
	[
		"a target rate of 0",
		{
			kind: "timer.throughput",
			invalid: { targetPerMinute: 0 },
			valid: { targetPerMinute: 60 },
		},
	],
	[
		"a malformed If condition",
		{
			kind: "control.if",
			invalid: { condition: "status == 200" },
			valid: { condition: "{{status}} == 200" },
		},
	],
	[
		"a status range with only a minimum",
		{
			kind: "assert.status",
			invalid: { range: { min: 200 } },
			valid: { range: { min: 200, max: 299 } },
		},
	],
];

const HEADER = { id: "h_1", key: "X-Trace", value: "1", enabled: true };

/** Reads the dirty flag and conflicts, and offers the edits each case makes. */
function ElementsProbe({ element }: { element: InvalidCase }) {
	const { request, updateField, hasUnsavedChanges, fieldConflicts } = useRequestBuilderContext();
	const setElement = (config: Record<string, unknown>) =>
		updateField("elements", [{ id: "el_1", kind: element.kind, enabled: true, config }]);
	return (
		<>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<span data-testid="element-config">{JSON.stringify(request.elements[0]?.config)}</span>
			<span data-testid="conflicts">{Object.keys(fieldConflicts).join(",")}</span>
			<button onClick={() => setElement(element.invalid)}>add the invalid element</button>
			<button onClick={() => setElement(element.valid)}>fix the element</button>
			<button onClick={() => updateField("url", "https://api.test/edited")}>
				edit the url
			</button>
			<button onClick={() => updateField("url", "https://api.test/edited-again")}>
				edit the url again
			</button>
			<button onClick={() => updateField("headers", [HEADER])}>add a header</button>
		</>
	);
}

const INITIAL: Partial<RequestState> = { id: "req_1", name: "Req", url: "https://api.test/a" };

function mount(element: InvalidCase, onSave: OnSave, initialRequest = INITIAL) {
	return render(
		<TestQueryClient>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId="col_1"
				onSave={onSave}
			>
				<ElementsProbe element={element} />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const shown = (testId: string) => screen.getByTestId(testId).textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

/**
 * `handleSave` the way `useSaveManager.performSave` calls it, returning what
 * it threw (`undefined` for a clean save) so a case can tell "held back" from
 * "saved" - the manager reads a `SaveBlockedError` as `"pending"`
 * (`useSaveManager.blocked.test.tsx`).
 */
async function save(): Promise<unknown> {
	let thrown: unknown;
	await act(() =>
		managerOptions.onSave().catch((error: unknown) => {
			thrown = error;
		})
	);
	return thrown;
}

const fieldsOf = (onSave: ReturnType<typeof vi.fn<OnSave>>, call: number) =>
	[...(onSave.mock.calls[call][1] as ReadonlySet<string>)].sort();

afterEach(cleanup);

describe.each(CASES)("a save while the request holds %s", (_label, element) => {
	it("sends nothing when the element is the only edit, and stays dirty", async () => {
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(element, onSave);
		click("add the invalid element");

		expect(await save()).toBeInstanceOf(SaveBlockedError);
		expect(onSave).not.toHaveBeenCalled();
		expect(shown("dirty")).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("saves the URL and header edits made beside it, without the element", async () => {
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(element, onSave);
		click("add the invalid element");
		click("edit the url");
		click("add a header");

		expect(await save()).toBeInstanceOf(SaveBlockedError);

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(fieldsOf(onSave, 0)).toEqual(["headers", "url"]);
		const sent = onSave.mock.calls[0][0];
		expect(sent.url).toBe("https://api.test/edited");
		expect(sent.headers).toEqual([HEADER]);
		// The element is held back, not dropped: still in the draft, still unsaved.
		expect(shown("element-config")).toBe(JSON.stringify(element.invalid));
		expect(shown("dirty")).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("sends nothing on a retry while the element is still invalid", async () => {
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(element, onSave);
		click("add the invalid element");
		click("edit the url");
		await save();

		expect(await save()).toBeInstanceOf(SaveBlockedError);
		// The URL already landed; re-sending it on every retry would be a PUT
		// per autosave tick for as long as the element stays invalid.
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(shown("dirty")).toBe("true");
	});

	it("sends the elements alone once fixed, and the request is then clean", async () => {
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		mount(element, onSave);
		click("add the invalid element");
		click("edit the url");
		await save();

		click("fix the element");
		expect(await save()).toBeUndefined();

		expect(onSave).toHaveBeenCalledTimes(2);
		expect(fieldsOf(onSave, 1)).toEqual(["elements"]);
		expect(onSave.mock.calls[1][0].elements[0].config).toEqual(element.valid);
		expect(shown("dirty")).toBe("false");
	});
});

describe("a save that holds the elements back, around the rest of the request", () => {
	const [, element] = CASES[0];

	it("keeps an edit that landed while the partial save was in flight", async () => {
		let land: () => void = () => {};
		const onSave = vi
			.fn<OnSave>()
			.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)))
			.mockResolvedValue(undefined);
		mount(element, onSave);
		click("add the invalid element");
		click("edit the url");

		let thrown: unknown;
		let inFlight: Promise<void> = Promise.resolve();
		act(() => {
			inFlight = managerOptions.onSave().catch((error: unknown) => {
				thrown = error;
			});
		});
		click("edit the url again");
		await act(async () => {
			land();
			await inFlight;
		});
		expect(thrown).toBeInstanceOf(SaveBlockedError);

		// The URL the user typed mid-flight is still touched, so the next save
		// carries it; the element is still held back.
		await save();
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(fieldsOf(onSave, 1)).toEqual(["url"]);
		expect(onSave.mock.calls[1][0].url).toBe("https://api.test/edited-again");
		expect(shown("dirty")).toBe("true");
	});

	it("keeps the held-back element when the server's answer arrives without it", async () => {
		const onSave = vi.fn<OnSave>().mockResolvedValue(undefined);
		const { rerender } = mount(element, onSave);
		click("add the invalid element");
		click("edit the url");
		await save();

		// The refetch after the PUT: the new URL, and the elements the engine
		// still stores (none), which is what the draft's baseline already holds.
		rerender(
			<TestQueryClient>
				<RequestBuilderProvider
					initialRequest={{ ...INITIAL, url: "https://api.test/edited", elements: [] }}
					collectionId="col_1"
					onSave={onSave}
				>
					<ElementsProbe element={element} />
				</RequestBuilderProvider>
			</TestQueryClient>
		);

		expect(shown("element-config")).toBe(JSON.stringify(element.invalid));
		expect(shown("conflicts")).toBe("");
		expect(shown("dirty")).toBe("true");
	});

	it("still reports an engine failure of the partial save as a failure", async () => {
		const failure = new Error("engine unreachable");
		const onSave = vi.fn<OnSave>().mockRejectedValue(failure);
		mount(element, onSave);
		click("add the invalid element");
		click("edit the url");

		expect(await save()).toBe(failure);
		expect(shown("dirty")).toBe("true");
	});
});

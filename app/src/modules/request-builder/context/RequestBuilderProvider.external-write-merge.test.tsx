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
 * The request builder's draft has to adopt an external write - typically an
 * MCP agent's `update_request` landing while the tab is open - for every
 * field, not only `name` (issue #1436). `RequestBuilderProvider.name-sync.test.tsx`
 * already covers the field this generalizes from; this file covers the
 * generalization itself:
 *
 *   - an untouched field adopts the external value silently, without being
 *     marked dirty (a save scheduled by adoption would write back what it
 *     just read);
 *   - a field the user has touched is left alone when the fetch disagrees,
 *     and the incoming value is surfaced as a conflict for "Take theirs" to
 *     resolve;
 *   - two different fields are independent: an adopt on one must not disturb
 *     a dirty edit on another;
 *   - a key/value table is compared as its stored rows, so a refetch that
 *     only renews the rows' ephemeral ids is no change and raises no conflict,
 *     and an adopted table keeps the ids of the rows it did not change (#3663);
 *   - a request moved to a different collection (the `move_item` case)
 *     updates just `collectionId` in place, keeping the rest of a dirty draft;
 *   - a render that resets the draft (a different request id or
 *     `initialResponse`) skips the merge, so the previous request's touched
 *     fields are not reported as conflicts over the fresh baseline (#3662);
 *   - a request deleted elsewhere disables the save manager, so its autosave
 *     timer cannot fire a PUT against an id that now 404s;
 *   - a foreign write landing while a save is in flight bumps the generation,
 *     so the save cannot claim the request clean over a field the merge just
 *     changed underneath its response.
 *
 * The harness mirrors `RequestBuilderProvider.save-generation.test.tsx`: a
 * mocked `useSaveManager` that hands back its options for the test to drive
 * and read, and a mocked `useVariableResolver` since none of this is about
 * resolution.
 */

import { describe, it, expect, vi } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState, ResponseState } from "../types";

let managerOptions: {
	onSave: () => Promise<void>;
	hasChanges: boolean;
	changeToken: number;
	enabled: boolean;
};

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
		enabled: boolean;
	}) => {
		managerOptions = options;
		return { forceSave: vi.fn(), status: "idle", isSaving: false };
	},
}));

vi.mock("@/queries", () => ({
	// RequestBuilderProvider now reads the catalogue itself (issue #1635); an
	// empty list means "nothing required", so the save-skip check is inert.
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
}));

/** The key/value tables, each compared as rows rather than by JSON (#3663). */
const ROW_TABLES = ["params", "headers", "formData", "urlEncoded"] as const;

/** Shows the fields these cases touch, and offers the writes they make. */
function FieldProbe() {
	const { request, updateField, hasUnsavedChanges, fieldConflicts, takeExternalField } =
		useRequestBuilderContext();
	return (
		<>
			<span data-testid="url">{request.url}</span>
			<span data-testid="name">{request.name}</span>
			{ROW_TABLES.map((field) => (
				<span key={field} data-testid={field}>
					{request[field].map((row) => `${row.id}:${row.key}=${row.value}`).join(" ")}
				</span>
			))}
			<span data-testid="description">{request.description}</span>
			<span data-testid="collectionId">{request.collectionId}</span>
			<span data-testid="protocol">
				{JSON.stringify([
					request.disableCookies,
					request.disabledSystemHeaders,
					request.disableUrlEncoding,
				])}
			</span>
			<span data-testid="timeout">{String(request.timeout)}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<span data-testid="conflicts">{Object.keys(fieldConflicts).sort().join(",")}</span>
			<span data-testid="conflict-url">{String(fieldConflicts.url ?? "")}</span>
			<button onClick={() => updateField("url", "https://typed.test/mine")}>type url</button>
			<button onClick={() => updateField("description", "typed description")}>
				type description
			</button>
			<button onClick={() => takeExternalField("url")}>take theirs: url</button>
			{ROW_TABLES.map((field) => (
				<button
					key={field}
					onClick={() =>
						updateField(
							field,
							request[field].map((row) =>
								row.key === "X-One" ? { ...row, value: "2" } : row
							)
						)
					}
				>
					type {field}
				</button>
			))}
		</>
	);
}

function Harness({
	initialRequest,
	collectionId,
	initialResponse,
	onSave,
}: {
	initialRequest?: Partial<RequestState>;
	collectionId?: string | null;
	initialResponse?: ResponseState | null;
	onSave?: (request: RequestState, changed: ReadonlySet<string>) => Promise<void>;
}) {
	return (
		<TestQueryClient>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId={collectionId ?? "col_1"}
				initialResponse={initialResponse}
				onSave={onSave}
			>
				<FieldProbe />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const EXTERNAL_TIMEOUT = 2500;

const shown = (testId: string) => screen.getByTestId(testId).textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

describe("the request builder's draft adopts an external write per field", () => {
	it("adopts an untouched field silently, without marking the tab dirty", () => {
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} />
		);
		expect(shown("url")).toBe("https://api.test/a");

		// An MCP agent's update_request landing on the same request.
		act(() =>
			rerender(<Harness initialRequest={{ id: "req_1", url: "https://api.test/b" }} />)
		);

		expect(shown("url")).toBe("https://api.test/b");
		expect(shown("dirty")).toBe("false");
		expect(shown("conflicts")).toBe("");
	});

	it("adopts Postman's protocol switches from an external write (#1765)", () => {
		// A field missing from the merge list is one an agent's edit never
		// reaches an open tab with - and the next autosave writes the stale
		// value back over it.
		const { rerender } = render(<Harness initialRequest={{ id: "req_1" }} />);
		expect(shown("protocol")).toBe("[false,[],false]");

		act(() =>
			rerender(
				<Harness
					initialRequest={{
						id: "req_1",
						disableCookies: true,
						disabledSystemHeaders: ["accept"],
						disableUrlEncoding: true,
					}}
				/>
			)
		);

		expect(shown("protocol")).toBe('[true,["accept"],true]');
		expect(shown("dirty")).toBe("false");
	});

	it("adopts a timeout set, then reset, by an external write (#2937)", () => {
		// `timeout` missing from the merge list would leave an agent's
		// update_request out of an open tab, and the next autosave would write the
		// stale value back; `null` (the reset) has to be adopted as a value too.
		const { rerender } = render(<Harness initialRequest={{ id: "req_1", timeout: null }} />);
		expect(shown("timeout")).toBe("null");

		act(() =>
			rerender(<Harness initialRequest={{ id: "req_1", timeout: EXTERNAL_TIMEOUT }} />)
		);
		expect(shown("timeout")).toBe(String(EXTERNAL_TIMEOUT));
		expect(shown("dirty")).toBe("false");

		act(() => rerender(<Harness initialRequest={{ id: "req_1", timeout: null }} />));
		expect(shown("timeout")).toBe("null");
		expect(shown("dirty")).toBe("false");
	});

	it("keeps the user's edit and flags a conflict when the same field changed on both sides", () => {
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} />
		);

		click("type url");
		expect(shown("url")).toBe("https://typed.test/mine");

		act(() =>
			rerender(<Harness initialRequest={{ id: "req_1", url: "https://api.test/agent" }} />)
		);

		// The user's edit is kept, not silently overwritten either direction.
		expect(shown("url")).toBe("https://typed.test/mine");
		expect(shown("conflicts")).toBe("url");
		expect(shown("conflict-url")).toBe("https://api.test/agent");

		click("take theirs: url");

		expect(shown("url")).toBe("https://api.test/agent");
		expect(shown("conflicts")).toBe("");
	});

	it("adopts one field while a different field stays dirty from the user's own edit", () => {
		const { rerender } = render(
			<Harness
				initialRequest={{
					id: "req_1",
					url: "https://api.test/a",
					description: "old description",
				}}
			/>
		);

		click("type description");
		expect(shown("dirty")).toBe("true");

		act(() =>
			rerender(
				<Harness
					initialRequest={{
						id: "req_1",
						url: "https://api.test/agent",
						description: "old description",
					}}
				/>
			)
		);

		// The untouched field adopts; the touched one is untouched by the merge.
		expect(shown("url")).toBe("https://api.test/agent");
		expect(shown("description")).toBe("typed description");
		expect(shown("conflicts")).toBe("");
		expect(shown("dirty")).toBe("true");
	});

	it("moves collectionId in place, keeping the rest of a dirty draft (the move_item case)", () => {
		const { rerender } = render(
			<Harness
				initialRequest={{ id: "req_1", url: "https://api.test/a" }}
				collectionId="col_1"
			/>
		);

		click("type description");
		expect(shown("dirty")).toBe("true");

		act(() =>
			rerender(
				<Harness
					initialRequest={{ id: "req_1", url: "https://api.test/a" }}
					collectionId="col_2"
				/>
			)
		);

		expect(shown("collectionId")).toBe("col_2");
		// The reset-on-id-change path would have thrown this away; the move path
		// must not.
		expect(shown("description")).toBe("typed description");
		expect(shown("dirty")).toBe("true");
	});

	it("does not report the previous request's edits as conflicts when a different request loads (#3662)", () => {
		const { rerender } = render(
			<Harness
				initialRequest={{
					id: "req_1",
					url: "https://api.test/one",
					description: "one description",
				}}
			/>
		);

		click("type url");
		click("type description");
		expect(shown("dirty")).toBe("true");

		act(() =>
			rerender(
				<Harness
					initialRequest={{
						id: "req_2",
						url: "https://api.test/two",
						description: "two description",
					}}
				/>
			)
		);

		// The reset seeds req_2's baseline; the merge must not run against req_1's
		// touched fields in the same render.
		expect(shown("conflicts")).toBe("");
		expect(shown("dirty")).toBe("false");
		expect(shown("url")).toBe("https://api.test/two");
		expect(shown("description")).toBe("two description");

		// The baseline is req_2's: editing it, then a refetch carrying the same
		// values, is no conflict.
		click("type url");
		act(() =>
			rerender(
				<Harness
					initialRequest={{
						id: "req_2",
						url: "https://api.test/two",
						description: "two description",
					}}
				/>
			)
		);

		expect(shown("url")).toBe("https://typed.test/mine");
		expect(shown("conflicts")).toBe("");
	});

	it("skips the merge in a render that changes only initialResponse (#3662)", () => {
		const first = { id: "req_1", url: "https://api.test/one" };
		const { rerender } = render(<Harness initialRequest={first} initialResponse={null} />);
		click("type url");

		act(() =>
			rerender(
				<Harness
					initialRequest={{ id: "req_1", url: "https://api.test/refetched" }}
					initialResponse={{} as ResponseState}
				/>
			)
		);

		expect(shown("conflicts")).toBe("");
		expect(shown("url")).toBe("https://api.test/refetched");
	});

	it("disables the save manager once the request is deleted elsewhere", () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} onSave={onSave} />
		);
		expect(managerOptions.enabled).toBe(true);

		click("type description");
		expect(shown("dirty")).toBe("true");

		// `index.tsx` keeps the provider mounted but stops handing it an
		// `initialRequest` once the fetch 404s.
		act(() => rerender(<Harness initialRequest={undefined} onSave={onSave} />));

		expect(managerOptions.enabled).toBe(false);
	});

	it("bumps the generation on a foreign write during an in-flight save, so the save cannot claim the request clean", async () => {
		// Same shape as `RequestBuilderProvider.save-generation.test.tsx`'s
		// `heldSave()`: a save this test holds open by hand, so a foreign write
		// can land while it is still in flight.
		let release!: () => void;
		const pending = new Promise<void>((r) => {
			release = r;
		});
		const onSave = vi.fn(() => pending);

		const { rerender } = render(
			<Harness initialRequest={{ id: "req_1", url: "https://api.test/a" }} onSave={onSave} />
		);

		click("type description");
		const savedGeneration = managerOptions.changeToken;
		// `void`, not awaited: `act` must run this synchronously, up to the
		// `await onSave(...)` inside `handleSave`, or it treats the callback as
		// async and returns before the foreign write below is even applied.
		act(() => void managerOptions.onSave());

		// A foreign write for a *different*, untouched field lands mid-flight.
		act(() =>
			rerender(
				<Harness
					initialRequest={{ id: "req_1", url: "https://api.test/agent" }}
					onSave={onSave}
				/>
			)
		);
		expect(managerOptions.changeToken).not.toBe(savedGeneration);
		expect(shown("url")).toBe("https://api.test/agent");

		await act(async () => {
			release();
			await pending;
		});

		// The save's response cannot be trusted to describe the merge that
		// happened after it was sent, so the request must still read dirty.
		expect(shown("dirty")).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	describe("a key/value table (#3663)", () => {
		/** A table's stored rows as `index.tsx` hands them over: fresh ids every time. */
		const fetched = (
			name: string,
			rows: { key: string; value: string }[],
			field: (typeof ROW_TABLES)[number] = "headers"
		) => ({
			id: "req_1",
			name,
			[field]: [
				...rows.map((entry, i) => ({ ...entry, id: `${name}-${i}`, enabled: true })),
				{ id: `${name}-spare`, key: "", value: "", enabled: true },
			],
		});

		it.each(ROW_TABLES)(
			"raises no %s conflict when an outside rename lands over an unsaved edit of it",
			(field) => {
				const { rerender } = render(
					<Harness
						initialRequest={fetched("Before", [{ key: "X-One", value: "1" }], field)}
					/>
				);
				click(`type ${field}`);
				const typed = shown(field);
				expect(typed).toBe("Before-0:X-One=2 Before-spare:=");

				// Another window renames the request; the refetch rebuilds the
				// untouched rows with new ids.
				act(() =>
					rerender(
						<Harness
							initialRequest={fetched("After", [{ key: "X-One", value: "1" }], field)}
						/>
					)
				);

				expect(shown("name")).toBe("After");
				expect(shown("conflicts")).toBe("");
				expect(shown(field)).toBe(typed);
			}
		);

		it("still raises a headers conflict when the outside write changed a header name", () => {
			const { rerender } = render(
				<Harness initialRequest={fetched("Before", [{ key: "X-One", value: "1" }])} />
			);
			click("type headers");

			act(() =>
				rerender(
					<Harness
						initialRequest={fetched("Before", [{ key: "X-Renamed", value: "1" }])}
					/>
				)
			);

			expect(shown("conflicts")).toBe("headers");
			expect(shown("headers")).toBe("Before-0:X-One=2 Before-spare:=");
		});

		it("adopts an untouched table keeping the ids of the rows it did not change", () => {
			const { rerender } = render(
				<Harness
					initialRequest={fetched("Before", [
						{ key: "X-Kept", value: "1" },
						{ key: "X-Edited", value: "1" },
					])}
				/>
			);

			act(() =>
				rerender(
					<Harness
						initialRequest={fetched("Before2", [
							{ key: "X-Kept", value: "1" },
							{ key: "X-Edited", value: "2" },
						])}
					/>
				)
			);

			// The kept row and the spare row keep the draft's ids, so neither
			// remounts; the row whose content changed takes the fetch's.
			expect(shown("headers")).toBe("Before-0:X-Kept=1 Before2-1:X-Edited=2 Before-spare:=");
			expect(shown("dirty")).toBe("false");
		});
	});
});

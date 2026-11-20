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
 * A save only gets to call the request clean if it carried every edit
 * (issue #1381).
 *
 * `onSave(request)` serialises the state as it was when the save started, and
 * the engine round trip is tens of milliseconds - a window a script editor
 * lands keystrokes in constantly. Clearing `hasUnsavedChanges` when that
 * promise resolved marked those keystrokes saved: the payload never held them,
 * nothing was left dirty, so `useSaveManager` never re-armed, and the Dock said
 * "Saved" over an edit that was gone on the next open.
 *
 * The provider therefore stamps every edit with a generation and clears the
 * flag only for the generation it actually sent. The mocked save manager here
 * is the seam: it hands back the options it was given, so a test can drive
 * `onSave` by hand and read the `hasChanges` / `changeToken` the hook would
 * have debounced on. That the hook then re-arms on those values is
 * `useSaveManager.debounce.test.tsx`.
 *
 * The same race has a second symptom (#3664): the cache's echo of what the
 * save sent disagrees with the newer draft, and must not read as someone
 * else's write. The last block covers that, with the echo landing on either
 * side of the save's resolve.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState } from "../types";

/** The options the provider handed the save manager on the last render. */
let managerOptions: { onSave: () => Promise<void>; hasChanges: boolean; changeToken: number };

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

/** One `script.post` element holding `text`, on the same id every edit reuses. */
function scriptElements(text: string) {
	return [{ id: "el_1", kind: "script.post", enabled: true, config: { script: text } }];
}

/** Reads the dirty flag and offers the one edit the cases make. */
function ScriptProbe() {
	const { request, updateField, hasUnsavedChanges } = useRequestBuilderContext();
	const script = request.elements.find((el) => el.kind === "script.post")?.config.script;
	return (
		<>
			<span data-testid="script">{typeof script === "string" ? script : ""}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<button onClick={() => updateField("elements", scriptElements("first"))}>
				type first
			</button>
			<button onClick={() => updateField("elements", scriptElements("second"))}>
				type second
			</button>
		</>
	);
}

/** A save the test holds open, so an edit can land while it is in flight. */
function heldSave() {
	const sent: RequestState[] = [];
	let release!: () => void;
	let pending = new Promise<void>((r) => {
		release = r;
	});
	const onSave = vi.fn((request: RequestState) => {
		sent.push(request);
		return pending;
	});
	return {
		onSave,
		sent,
		/** Let the in-flight save land, and arm the next one. */
		finish: async () => {
			const done = release;
			pending = new Promise<void>((r) => {
				release = r;
			});
			await act(async () => {
				done();
			});
		},
	};
}

const dirty = () => screen.getByTestId("dirty").textContent;
const click = (label: string) => act(() => screen.getByText(label).click());
const save = () => act(() => void managerOptions.onSave());

describe("a save that raced an edit", () => {
	let saves: ReturnType<typeof heldSave>;
	const harness = () => saves;

	beforeEach(() => {
		const initialRequest: Partial<RequestState> = { id: "req_1", name: "Req" };
		saves = heldSave();
		render(
			<TestQueryClient>
				<RequestBuilderProvider
					initialRequest={initialRequest}
					collectionId="col_1"
					onSave={saves.onSave}
				>
					<ScriptProbe />
				</RequestBuilderProvider>
			</TestQueryClient>
		);
	});

	it("leaves the request dirty, so the next save is still scheduled", async () => {
		click("type first");
		expect(dirty()).toBe("true");

		save();
		// The keystroke the flying payload does not carry.
		click("type second");

		await harness().finish();

		expect(dirty()).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("sends the newer state on the save that follows", async () => {
		click("type first");
		save();
		click("type second");
		await harness().finish();

		// The save manager only issues this one because the request is still
		// marked dirty; asserting the flag here is what ties the payload below
		// to the generation check rather than to the test calling `onSave`.
		expect(managerOptions.hasChanges).toBe(true);
		save();
		await harness().finish();

		expect(
			harness().sent.map(
				(r) => r.elements.find((el) => el.kind === "script.post")?.config.script
			)
		).toEqual(["first", "second"]);
	});

	it("still reports clean when nothing was typed during the flight", async () => {
		click("type first");
		expect(dirty()).toBe("true");

		save();
		await harness().finish();

		expect(dirty()).toBe("false");
	});

	it("stamps each edit with a new generation for the debounce to restart on", () => {
		click("type first");
		const afterFirst = managerOptions.changeToken;

		click("type second");

		expect(managerOptions.changeToken).not.toBe(afterFirst);
	});
});

/** One `X-One` header holding `value`, with ids as fresh as each fetch makes them. */
function headerRows(value: string, idPrefix: string) {
	return [
		{ id: `${idPrefix}-0`, key: "X-One", value, enabled: true },
		{ id: `${idPrefix}-spare`, key: "", value: "", enabled: true },
	];
}

/** Shows the url, the header and the conflicts, and offers the edits the cases type. */
function EchoProbe() {
	const { request, updateField, fieldConflicts } = useRequestBuilderContext();
	const typeHeader = (value: string) =>
		updateField(
			"headers",
			request.headers.map((row) => (row.key === "X-One" ? { ...row, value } : row))
		);
	return (
		<>
			<span data-testid="url">{request.url}</span>
			<span data-testid="header">
				{request.headers.find((row) => row.key === "X-One")?.value}
			</span>
			<span data-testid="conflicts">{JSON.stringify(fieldConflicts)}</span>
			<button onClick={() => updateField("url", "https://ab")}>type ab</button>
			<button onClick={() => updateField("url", "https://abc")}>type abc</button>
			<button onClick={() => typeHeader("2")}>type header 2</button>
			<button onClick={() => typeHeader("3")}>type header 3</button>
		</>
	);
}

function EchoHarness({
	stored,
	onSave,
}: {
	stored: Partial<RequestState>;
	onSave: (request: RequestState) => Promise<void>;
}) {
	return (
		<TestQueryClient>
			<RequestBuilderProvider initialRequest={stored} collectionId="col_1" onSave={onSave}>
				<EchoProbe />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

describe("the echo of a save an edit raced (#3664)", () => {
	const shown = (testId: string) => screen.getByTestId(testId).textContent;

	/**
	 * Stored `https://a`, typed `https://ab`, saved, typed `https://abc` while
	 * the save is in the air. `deliver` hands the provider a fetched copy, as
	 * the detail cache does: a new object with the same id.
	 */
	function raceAUrlSave() {
		const saves = heldSave();
		const { rerender } = render(
			<EchoHarness stored={{ id: "req_1", url: "https://a" }} onSave={saves.onSave} />
		);
		click("type ab");
		save();
		click("type abc");
		const deliver = (url: string) =>
			act(() =>
				rerender(<EchoHarness stored={{ id: "req_1", url }} onSave={saves.onSave} />)
			);
		return { saves, deliver };
	}

	it("raises no conflict when the echo lands before the save resolves", async () => {
		const { saves, deliver } = raceAUrlSave();

		deliver("https://ab");
		expect(shown("conflicts")).toBe("{}");
		expect(shown("url")).toBe("https://abc");

		await saves.finish();
		expect(shown("conflicts")).toBe("{}");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("raises no conflict when the echo lands after the save resolves", async () => {
		const { saves, deliver } = raceAUrlSave();

		await saves.finish();
		deliver("https://ab");

		expect(shown("conflicts")).toBe("{}");
		expect(shown("url")).toBe("https://abc");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("sends the newer url on the follow-up save, and settles on its echo", async () => {
		const { saves, deliver } = raceAUrlSave();
		deliver("https://ab");
		await saves.finish();

		save();
		await saves.finish();
		deliver("https://abc");

		expect(saves.sent.map((r) => r.url)).toEqual(["https://ab", "https://abc"]);
		expect(shown("conflicts")).toBe("{}");
		expect(managerOptions.hasChanges).toBe(false);
	});

	it("still conflicts on a value the save did not send", async () => {
		const { saves, deliver } = raceAUrlSave();

		deliver("https://other");

		expect(shown("conflicts")).toBe(JSON.stringify({ url: "https://other" }));
		expect(shown("url")).toBe("https://abc");
		await saves.finish();
	});

	it("recognises the first save's echo after a queued second save has started", async () => {
		// `useSaveManager` starts a queued save in the microtask after the first
		// resolves, before the first's cache write has rendered.
		const { saves, deliver } = raceAUrlSave();
		await saves.finish();
		save();

		deliver("https://ab");

		expect(shown("conflicts")).toBe("{}");
		expect(shown("url")).toBe("https://abc");
		await saves.finish();
	});

	it("still conflicts on the value of a save that failed", async () => {
		// A failed save has no echo, so an outside write of its value is not one.
		let fail!: (error: Error) => void;
		const onSave = vi.fn(
			() =>
				new Promise<void>((_, reject) => {
					fail = reject;
				})
		);
		const { rerender } = render(
			<EchoHarness stored={{ id: "req_1", url: "https://a" }} onSave={onSave} />
		);
		click("type ab");
		act(() => void managerOptions.onSave().catch(() => undefined));
		click("type abc");
		await act(async () => fail(new Error("engine unavailable")));

		act(() =>
			rerender(<EchoHarness stored={{ id: "req_1", url: "https://ab" }} onSave={onSave} />)
		);

		expect(shown("conflicts")).toBe(JSON.stringify({ url: "https://ab" }));
		expect(shown("url")).toBe("https://abc");
	});

	it("forgets what was sent once a different request loads", async () => {
		const saves = heldSave();
		const { rerender } = render(
			<EchoHarness stored={{ id: "req_1", url: "https://a" }} onSave={saves.onSave} />
		);
		click("type ab");
		save();
		await saves.finish();

		act(() =>
			rerender(
				<EchoHarness stored={{ id: "req_2", url: "https://two" }} onSave={saves.onSave} />
			)
		);
		click("type abc");
		// Another client writes req_1's last sent value into req_2.
		act(() =>
			rerender(
				<EchoHarness stored={{ id: "req_2", url: "https://ab" }} onSave={saves.onSave} />
			)
		);

		expect(shown("conflicts")).toBe(JSON.stringify({ url: "https://ab" }));
	});

	it("recognises a table's echo by its stored rows, not its ids", async () => {
		const saves = heldSave();
		const stored = (value: string, idPrefix: string) => ({
			id: "req_1",
			headers: headerRows(value, idPrefix),
		});
		const { rerender } = render(
			<EchoHarness stored={stored("1", "first")} onSave={saves.onSave} />
		);
		click("type header 2");
		save();
		click("type header 3");

		act(() => rerender(<EchoHarness stored={stored("2", "echo")} onSave={saves.onSave} />));

		expect(shown("conflicts")).toBe("{}");
		expect(shown("header")).toBe("3");
		await saves.finish();
	});
});

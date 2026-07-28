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
 * Body drafts have to outlive `BodyPanel`, which is why they live here.
 *
 * The drafts stop a mode switch from destroying your body (see
 * `utils/body-drafts.ts`). They started as a ref inside `BodyPanel`, and that
 * was the wrong home for a reason nothing in the pure-function tests could see:
 * `RequestTabs` renders one `TabsContent` per tab and Radix mounts only the
 * active one, so stepping over to Headers and back tears `BodyPanel` down. A
 * panel-local ref went with it - stash JSON behind GraphQL, glance at Headers,
 * come back, and the JSON was gone.
 *
 * What is tested here is the **lifetime**, which is the thing that changed: the
 * drafts survive a consumer unmounting and remounting, and survive the provider
 * re-rendering. A stand-in consumer stands in for `BodyPanel` on purpose - the
 * real panel only stashes when a Radix `Select` commits a value, and a Select
 * does not commit in jsdom (it raises no pointer events). Driving it through
 * the UI would produce a test that looks like it exercises the switch and
 * exercises none of it, which has already happened once in this codebase.
 *
 * The rule the drafts follow - two buckets, and ownership by request id - is
 * tested as logic in `utils/body-drafts.test.ts`.
 *
 * The second half of the file guards the same lifetime for the second thing
 * kept up here for the same reason: which Content-Type row a body mode added,
 * so that leaving the mode can remove it (`panels/body/content-type.ts`).
 */

import { describe, it, expect, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { switchBody } from "../utils/body-drafts";
import type { AutoContentType, RequestState } from "../types";

// The provider is wired to variable resolution, the save manager and several
// TanStack Query hooks. None of them matter to a ref's lifetime.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
}));

const JSON_BODY = '{"merchant":"mrc_8813"}';

/** What the mounted stand-in last saw. */
const seen: { restored: string | null } = { restored: null };

/**
 * Stands in for `BodyPanel`: on mount it stashes or restores through the
 * context accessors, exactly as `handleModeChange` does.
 */
function PanelStandIn({ stash }: { stash?: boolean }) {
	const { getBodyDrafts, setBodyDrafts, request } = useRequestBuilderContext();
	useEffect(() => {
		if (stash) {
			// json -> graphql: the JSON goes into the raw bucket.
			setBodyDrafts(
				switchBody("json", "graphql", JSON_BODY, request.id, getBodyDrafts()).drafts
			);
			seen.restored = null;
			return;
		}
		// graphql -> json: whatever the raw bucket is still holding.
		seen.restored = switchBody("graphql", "json", "", request.id, getBodyDrafts()).body;
	}, [getBodyDrafts, setBodyDrafts, request.id, stash]);
	return null;
}

/** Mounts the stand-in, lets the test unmount it, then mounts it again. */
function Harness() {
	const [step, setStep] = useState<"stash" | "away" | "back">("stash");
	useEffect(() => {
		harnessStep = setStep;
	}, []);
	if (step === "stash") return <PanelStandIn stash />;
	if (step === "away") return null; // the Headers tab: BodyPanel is unmounted
	return <PanelStandIn />;
}

let harnessStep: (s: "stash" | "away" | "back") => void = () => {};

const tree = (id: string | null) => (
	<RequestBuilderProvider initialRequest={{ id, name: "r" } as Partial<RequestState>}>
		<Harness />
	</RequestBuilderProvider>
);

function renderProvider(id: string | null = "req_a") {
	seen.restored = null;
	return render(tree(id));
}

describe("drafts across a tab switch", () => {
	it("survives BodyPanel unmounting and coming back", async () => {
		renderProvider();

		// Leave the Body tab, then return - Radix unmounts the inactive panel,
		// which is exactly what threw a panel-local ref away.
		await act(async () => harnessStep("away"));
		await act(async () => harnessStep("back"));

		expect(seen.restored).toBe(JSON_BODY);
	});

	it("survives the provider re-rendering while the panel is away", async () => {
		// The drafts are behind accessors, so "did it survive" cannot be answered
		// by comparing object identity any more. A provider that rebuilt its
		// store each render would lose them here and pass the test above.
		const { rerender } = renderProvider();

		await act(async () => harnessStep("away"));
		await act(async () => rerender(tree("req_a")));
		await act(async () => harnessStep("back"));

		expect(seen.restored).toBe(JSON_BODY);
	});

	it("starts empty for a provider that has stashed nothing", async () => {
		// Guards both assertions above from passing on a stale module-level value.
		seen.restored = "sentinel";
		render(
			<RequestBuilderProvider initialRequest={{ id: "req_z" } as Partial<RequestState>}>
				<PanelStandIn />
			</RequestBuilderProvider>
		);
		await act(async () => {});
		expect(seen.restored).toBe("");
	});
});

/**
 * The record of the Content-Type row a body mode added lives here for the same
 * reason and one of its own: the panel is unmounted while any other tab is on
 * screen, so a panel-local record is gone by the next mode change - and then
 * nothing removes the header, which is the bug the record exists to fix.
 */
const ADDED: AutoContentType = { requestId: "req_a", rowId: "row_1", value: "application/json" };

const contentType: { read: AutoContentType | null } = { read: null };

function ContentTypeStandIn({ write }: { write?: boolean }) {
	const { getAutoContentType, setAutoContentType } = useRequestBuilderContext();
	useEffect(() => {
		if (write) {
			setAutoContentType(ADDED);
			contentType.read = null;
			return;
		}
		contentType.read = getAutoContentType();
	}, [getAutoContentType, setAutoContentType, write]);
	return null;
}

function ContentTypeHarness() {
	const [step, setStep] = useState<"write" | "away" | "back">("write");
	useEffect(() => {
		contentTypeStep = setStep;
	}, []);
	if (step === "write") return <ContentTypeStandIn write />;
	if (step === "away") return null; // the Headers tab: BodyPanel is unmounted
	return <ContentTypeStandIn />;
}

let contentTypeStep: (s: "write" | "away" | "back") => void = () => {};

describe("the added Content-Type row across a tab switch", () => {
	it("is still known after BodyPanel unmounts and comes back", async () => {
		contentType.read = null;
		render(
			<RequestBuilderProvider initialRequest={{ id: "req_a" } as Partial<RequestState>}>
				<ContentTypeHarness />
			</RequestBuilderProvider>
		);

		await act(async () => contentTypeStep("away"));
		await act(async () => contentTypeStep("back"));

		expect(contentType.read).toEqual(ADDED);
	});

	it("is null for a provider that has added nothing", async () => {
		// Guards the assertion above from passing on a stale module-level value.
		contentType.read = ADDED;
		render(
			<RequestBuilderProvider initialRequest={{ id: "req_z" } as Partial<RequestState>}>
				<ContentTypeStandIn />
			</RequestBuilderProvider>
		);
		await act(async () => {});
		expect(contentType.read).toBeNull();
	});
});

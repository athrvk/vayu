/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useTabsStore } from "./tabs-store";
import { useSaveStore, type SaveContext } from "./save-store";
import { useResponseStore } from "./response-store";

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useSaveStore.setState({ contexts: new Map() });
});

describe("closeTabsForEntities", () => {
	function openRequests(ids: string[]) {
		for (const id of ids) useTabsStore.getState().openTab({ type: "request", entityId: id });
	}

	it("closes a non-active tab and leaves the active tab focused", () => {
		openRequests(["a", "b", "c"]); // active becomes the last opened, "c"
		const activeBefore = useTabsStore.getState().activeTabId;

		useTabsStore.getState().closeTabsForEntities(["a"]);

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.map((t) => t.entityId)).toEqual(["b", "c"]);
		expect(activeTabId).toBe(activeBefore); // "c" still active
	});

	it("focuses the left neighbor when the active tab is closed", () => {
		openRequests(["a", "b", "c"]);
		// Focus the middle tab "b"
		const bTab = useTabsStore.getState().openTabs.find((t) => t.entityId === "b")!;
		useTabsStore.getState().focusTab(bTab.id);

		useTabsStore.getState().closeTabsForEntities(["b"]);

		const { openTabs, activeTabId } = useTabsStore.getState();
		const aTab = openTabs.find((t) => t.entityId === "a")!;
		expect(activeTabId).toBe(aTab.id); // left neighbor
	});

	it("closes several entities at once (e.g. a collection cascade)", () => {
		openRequests(["r1", "r2"]);
		useTabsStore.getState().openTab({ type: "collection", entityId: "col" });

		useTabsStore.getState().closeTabsForEntities(["col", "r1", "r2"]);

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
		expect(useTabsStore.getState().activeTabId).toBeNull();
	});

	it("never closes singleton tabs that have a null entityId", () => {
		useTabsStore.getState().openTab({ type: "welcome", entityId: null });
		openRequests(["a"]);

		useTabsStore.getState().closeTabsForEntities(["a"]);

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => t.type)).toEqual(["welcome"]);
	});

	it("is a no-op when nothing matches", () => {
		openRequests(["a", "b"]);
		const before = useTabsStore.getState();

		useTabsStore.getState().closeTabsForEntities(["nonexistent"]);

		expect(useTabsStore.getState().openTabs).toEqual(before.openTabs);
		expect(useTabsStore.getState().activeTabId).toBe(before.activeTabId);
	});

	it("closes only the named kind of tab when a type is given", () => {
		// Deleting a run must not reach a request tab that happens to carry the
		// same id. Ids are engine-generated and do not collide, so this is about
		// the call site stating what a deletion is allowed to close.
		useTabsStore.getState().openTab({ type: "run", entityId: "x" });
		openRequests(["x"]);

		useTabsStore.getState().closeTabsForEntities(["x"], "run");

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => t.type)).toEqual(["request"]);
	});

	it("still closes every kind when no type is given", () => {
		useTabsStore.getState().openTab({ type: "run", entityId: "x" });
		openRequests(["x"]);

		useTabsStore.getState().closeTabsForEntities(["x"]);

		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});
});

/**
 * LRU eviction must never take unsaved work.
 *
 * The guard used to look up `request-${entityId}` and nothing else, so the two
 * tabs with no `entityId` at all - Settings and Variables, both singletons -
 * read as clean no matter what was typed into them, and the 13th tab silently
 * closed one. Their contexts register under "settings" / "globals-editor" /
 * "environment-<id>" / "collection-<id>", which is what these drive.
 *
 * Reverting the guard to the old `request-` lookup fails every case in the
 * second describe and none in the first.
 */

/** Register a dirty save context the way the editors do. */
function markDirty(contextId: string) {
	const context: SaveContext = {
		id: contextId,
		name: contextId,
		save: () => Promise.resolve(),
		hasPendingChanges: true,
	};
	useSaveStore.getState().registerContext(context);
}

/** Fill past MAX_OPEN_TABS (12) so the next open has to evict something. */
function openRequestTabs(count: number) {
	for (let i = 0; i < count; i++) {
		useTabsStore.getState().openTab({ type: "request", entityId: `req_${i}` });
	}
}

function openTypes(): string[] {
	return useTabsStore.getState().openTabs.map((t) => t.type);
}

describe("LRU eviction and a clean tab", () => {
	it("evicts the oldest tab once the cap is passed", () => {
		openRequestTabs(13);
		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		expect(ids).toHaveLength(12);
		expect(ids).not.toContain("req_0");
	});

	it("still evicts a request tab whose context is clean", () => {
		useTabsStore.getState().openTab({ type: "request", entityId: "clean" });
		useSaveStore.getState().registerContext({
			id: "request-clean",
			name: "Request",
			save: () => Promise.resolve(),
			hasPendingChanges: false,
		});
		openRequestTabs(12);

		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		expect(ids).not.toContain("clean");
	});
});

describe("LRU eviction never takes a dirty tab", () => {
	it("spares a dirty request tab, as it always did", () => {
		useTabsStore.getState().openTab({ type: "request", entityId: "dirty" });
		markDirty("request-dirty");
		openRequestTabs(12);

		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		expect(ids).toContain("dirty");
	});

	it("spares a dirty Settings tab, which has no entityId to look up", () => {
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		markDirty("settings");
		openRequestTabs(12);

		expect(openTypes()).toContain("settings");
	});

	it("spares a dirty Variables tab editing globals", () => {
		useTabsStore.getState().openTab({ type: "variables", entityId: null });
		markDirty("globals-editor");
		openRequestTabs(12);

		expect(openTypes()).toContain("variables");
	});

	it("spares a dirty Variables tab editing an environment", () => {
		useTabsStore.getState().openTab({ type: "variables", entityId: null });
		markDirty("environment-env_1");
		openRequestTabs(12);

		expect(openTypes()).toContain("variables");
	});

	it("spares a dirty Variables tab editing a collection", () => {
		useTabsStore.getState().openTab({ type: "variables", entityId: null });
		markDirty("collection-col_1");
		openRequestTabs(12);

		expect(openTypes()).toContain("variables");
	});

	/**
	 * One case per key family a collection tab's editors can register.
	 *
	 * `VariableTableEditor` keys on the bare id; the Info, Auth and the two
	 * Script panels suffix it (`useDraftSaveContext`). The case used to match
	 * only the bare key, so every suffixed sibling read as clean - the
	 * "under-matching discards someone's work" direction the guard's own header
	 * names. Reverting the prefix match fails all four suffix cases.
	 */
	it.each([
		["the Variables sub-tab", "collection-col_1"],
		["the Info tab", "collection-col_1-info"],
		["the Auth tab", "collection-col_1-auth"],
		["the pre-request Script tab", "collection-col_1-preRequestScript"],
		["the post-request Script tab", "collection-col_1-postRequestScript"],
	])("spares a collection tab dirty in %s", (_label, contextId) => {
		useTabsStore.getState().openTab({ type: "collection", entityId: "col_1" });
		markDirty(contextId);
		openRequestTabs(12);

		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		expect(ids).toContain("col_1");
	});

	it("evicts a collection tab when it is a different collection that is dirty", () => {
		// The discriminating case for the prefix match: matching a bare
		// `collection-` would spare every collection tab whenever any one of
		// them held edits.
		useTabsStore.getState().openTab({ type: "collection", entityId: "col_1" });
		markDirty("collection-col_2-auth");
		openRequestTabs(12);

		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		expect(ids).not.toContain("col_1");
	});

	it("evicts a clean Settings tab, so the guard is not just refusing everything", () => {
		// The discriminating case: a guard that reported every singleton dirty
		// would pass all five above and fail here.
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		openRequestTabs(12);

		expect(openTypes()).not.toContain("settings");
	});

	it("drops none of them when every existing tab is dirty", () => {
		for (let i = 0; i < 13; i++) {
			useTabsStore.getState().openTab({ type: "request", entityId: `req_${i}` });
			markDirty(`request-req_${i}`);
		}

		// The only tab the predicate can select here is the one just opened,
		// which carries no edits yet. Every tab holding work survives.
		const ids = useTabsStore.getState().openTabs.map((t) => t.entityId);
		for (let i = 0; i < 12; i++) expect(ids).toContain(`req_${i}`);
	});
});

/**
 * Nothing else evicts from the response map.
 *
 * `response-store` is keyed by request id, holds a body plus its raw copy per
 * entry, and had no caller for either of its clearing actions - so a session
 * that opened many requests kept every response it had ever seen, including for
 * requests that no longer exist. Both callers of `closeTabsForEntities` reach it
 * after a delete (one request, or a collection and everything under it), which
 * makes it the seam where the ids are known to be gone for good.
 */
describe("closeTabsForEntities evicts stored responses", () => {
	const storeResponse = (requestId: string) =>
		useResponseStore.getState().setResponse(requestId, {
			status: 200,
			statusText: "OK",
			headers: {},
			body: "{}",
			bodyType: "json",
			size: 2,
			time: 1,
		});

	beforeEach(() => useResponseStore.getState().clearAll());

	it("drops the response of a deleted request", () => {
		useTabsStore.getState().openTab({ type: "request", entityId: "r1" });
		storeResponse("r1");

		useTabsStore.getState().closeTabsForEntities(["r1"]);

		expect(useResponseStore.getState().getResponse("r1")).toBeNull();
	});

	it("drops every response in a collection cascade", () => {
		storeResponse("r1");
		storeResponse("r2");
		storeResponse("survivor");

		// The tree hands over the collection plus every descendant it gathered.
		useTabsStore.getState().closeTabsForEntities(["col_1", "r1", "r2"]);

		expect(useResponseStore.getState().getResponse("r1")).toBeNull();
		expect(useResponseStore.getState().getResponse("r2")).toBeNull();
		expect(useResponseStore.getState().getResponse("survivor")).not.toBeNull();
	});

	it("drops the response even when no tab was open on the request", () => {
		// The early return for "nothing matched" sits after the eviction on
		// purpose: a deleted request with no tab still had a response cached.
		storeResponse("r_no_tab");

		useTabsStore.getState().closeTabsForEntities(["r_no_tab"]);

		expect(useResponseStore.getState().getResponse("r_no_tab")).toBeNull();
	});

	it("leaves responses alone for a run-scoped sweep", () => {
		// Clear-history and the run-delete path pass run ids with `type: "run"`.
		// A run id cannot key a response, so walking them would only look like it
		// meant something - and would collide if the id families ever overlapped.
		storeResponse("r1");

		useTabsStore.getState().closeTabsForEntities(["r1"], "run");

		expect(useResponseStore.getState().getResponse("r1")).not.toBeNull();
	});

	it("leaves responses alone when handed nothing", () => {
		storeResponse("r1");
		useTabsStore.getState().closeTabsForEntities([]);
		expect(useResponseStore.getState().getResponse("r1")).not.toBeNull();
	});
});

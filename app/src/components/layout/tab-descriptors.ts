/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What every open tab is called, and which glyph carries its kind.
 *
 * Lives beside `TabStrip` rather than inside it because a second surface asks
 * the same question: the command palette lists open tabs, and a tab that reads
 * "GET /v1/orders" in the strip and "Request" in the palette is two answers to
 * one question. A hand-rolled copy would also never receive this file's fixes -
 * the run-tab naming below took three passes to get right.
 */

// `Zap` stays: here it is the load-test mark, which is what the bolt means
// throughout the app. `Braces` is the variables mark (see `Dock.tsx`).
import { Folder, Zap, Braces, Clock, Settings, Inbox, Radio } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { requestDetailOptions, runDetailOptions, useCollectionsQuery } from "@/queries";
import { walkAncestors } from "@/modules/collections/tree-utils";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { boundRowFor, useBoundRowStore, type Tab } from "@/stores";

/**
 * Extract a short display path from a request URL. URLs may contain
 * {{variables}} or be malformed mid-edit, so this never throws.
 */
export function pathLabel(url: string): string {
	if (!url) return "";
	try {
		return decodeURIComponent(new URL(url).pathname) || "/";
	} catch {
		// Strip scheme+host if present, otherwise show the raw string
		const stripped = url.replace(/^[a-z]+:\/\/[^/]*/i, "");
		return decodeURIComponent(stripped) || decodeURIComponent(url);
	}
}

/**
 * Title for a request tab: the user-set name when there is one, otherwise the
 * request path. A blank or still-default placeholder name counts as "not set".
 */
export function requestTabTitle(name: string, resolvedUrl: string): string {
	const trimmed = name.trim();
	if (trimmed && trimmed !== DEFAULT_REQUEST_NAME) return trimmed;
	return pathLabel(resolvedUrl) || trimmed;
}

/**
 * What a tab draws, resolved from the store plus whatever queries name it.
 *
 * Split out from rendering so the strip can measure a tab without laying it
 * out - see tab-fit.ts for why measuring the DOM would be circular.
 */
export interface TabDescriptor {
	/** The name shown in the strip. */
	label: string;
	/** Plain-text form, for the native tooltip when the label is truncated. */
	title: string;
	/** HTTP method, when the tab has one. Drawn as the leading colour rail. */
	method?: string;
	/** Leading glyph, for tab types that are not a plain request. */
	icon?: typeof Folder;
	/** True when the label is a URL path, which is cut from the left instead. */
	isPath?: boolean;
	/**
	 * Where the request lives, as the breadcrumb reads it: its collection chain
	 * and then its own name. Request tabs only, and absent until the request has
	 * loaded - what the tab menu's "Copy Path" copies (#1360).
	 *
	 * Built here rather than in the menu because this hook already holds both
	 * halves - the request and the collections list - and a menu that fetched
	 * them again would make every open tab a second subscriber to answer a
	 * question only the right-clicked one asks.
	 */
	path?: string;
}

/**
 * Icons carry the tab's *kind*; the rail carries its method.
 *
 * Freeing the icon from repeating the method is what lets a run say which kind
 * of run it is. Both kinds used to be `Clock`, and the old comment conceded the
 * point - "the tooltip says which kind" - which a glance cannot read. A
 * finished load test now takes the same `Zap` as the live dashboard, because it
 * is the same thing at a later time.
 */
export function iconForTab(
	tab: Tab,
	runType?: string,
	isCollectionRun?: boolean
): typeof Folder | undefined {
	switch (tab.type) {
		case "collection":
			return Folder;
		case "dashboard":
			return Zap;
		case "run":
			// A collection run's work is a sequence, the same identity a plain
			// collection tab has - so it gets that tab's icon rather than the
			// load/design pair below, which both mean "one request".
			return isCollectionRun ? Folder : runType === "load" ? Zap : Clock;
		case "variables":
			// The Dock and the welcome Launcher both open this view from a `Braces`
			// control; the tab it opened carried no icon at all, so the glyph the
			// user pressed vanished on arrival. See the note in `Dock.tsx`.
			return Braces;
		case "settings":
			return Settings;
		case "inbox":
			// The same glyph the Launcher tile that opens it carries.
			return Inbox;
		case "mock-server":
			// The Services drawer's own glyph for the group this tab addresses
			// one row of (`drawer-views.ts`'s `services` entry) - concentric
			// arcs, the "listening" mark inboxes and issuers share too.
			return Radio;
		default:
			return undefined;
	}
}

/**
 * Resolves what every open tab is called, in one hook.
 *
 * It has to be one hook for the whole list, not one per tab: the strip must
 * know each label *before* it can decide how many fit, and a hook inside a map
 * is a variable number of hooks. `useQueries` is the supported primitive for a
 * dynamic list, fed the same options objects `useRequestQuery` and
 * `useRunQuery` use, so the retry and 404 rules are not restated here.
 *
 * **The resolver is called once, without a collection id.** It previously ran
 * per tab with that tab's own `collectionId`, which cannot survive the move to
 * a single hook. It only affects the label of a request that has *no name of
 * its own* and whose URL uses a collection-scoped variable from a collection
 * other than the session's active one; that tab shows the unresolved
 * `{{var}}/path` instead of the concrete path. Globals, the environment and the
 * active collection all still resolve.
 */
export function useTabDescriptors(tabs: Tab[]): TabDescriptor[] {
	const requests = useQueries({
		queries: tabs.map((t) => requestDetailOptions(t.type === "request" ? t.entityId : null)),
	});
	const runs = useQueries({
		queries: tabs.map((t) => runDetailOptions(t.type === "run" ? t.entityId : null)),
	});
	const { data: collections = [] } = useCollectionsQuery();
	const { resolveString } = useVariableResolver();
	/*
	 * The row the open builder is bound to (issue #1074). One resolver serves the
	 * whole list, so the row cannot be an option on it the way it is inside the
	 * builder - it is passed per call instead, for the one tab it belongs to.
	 * Null for every ordinary Send, which is the state this strip has always been
	 * in.
	 */
	const bound = useBoundRowStore((s) => s.bound);

	return tabs.map((tab, i) => {
		const request = requests[i]?.data;
		const run = runs[i]?.data;
		/*
		 * A collection run has no url or no method - its work is a sequence -
		 * so it is read off the snapshot's own scenario manifest, the full
		 * shape `configSnapshot` carries (GET /runs/:id), unlike the list
		 * row's derived `summary.scenario`. Read wherever the manifest is
		 * present rather than gated on `run.type === "scenario"`: a scenario
		 * *load* run (#357) is `type: "load"` but still has no url/method of
		 * its own, the same reason the history row reads its descriptor the
		 * same way.
		 */
		const scenario = run?.configSnapshot?.scenario as { collectionId?: string } | undefined;
		const collectionId = scenario?.collectionId;
		const icon = iconForTab(tab, run?.type, Boolean(collectionId));

		switch (tab.type) {
			case "welcome":
				return { label: "Vayu", title: "Vayu" };
			case "settings":
				return { label: "Settings", title: "Settings", icon };
			case "variables":
				return { label: "Variables", title: "Variables", icon };
			case "inbox":
				return { label: "Inbox", title: "Webhook Inbox", icon };
			case "mock-server":
				return { label: "Mock Server", title: "Mock Server", icon };
			case "dashboard":
				return { label: "Load Test", title: "Load Test", icon };
			case "collection": {
				const name = collections.find((c) => c.id === tab.entityId)?.name ?? "Collection";
				return { label: name, title: name, icon };
			}
			case "request": {
				if (!request) return { label: "Request", title: "Request" };
				const name = requestTabTitle(
					request.name,
					resolveString(request.url, boundRowFor(bound, tab.entityId))
				);
				return {
					label: name,
					title: `${request.method} ${name}`,
					method: request.method,
					// A request with no name of its own falls back to its path, so
					// path labels are not confined to run tabs.
					isPath: name.startsWith("/"),
					// `walkAncestors` returns the chain root-first and carries the
					// cycle guard a hand-rolled parent walk would not.
					path: [
						...walkAncestors(request.collectionId, collections).map((c) => c.name),
						name,
					].join(" / "),
				};
			}
			case "run": {
				// A run tab is a past design run, load test, or collection run.
				// "Run" told none of them apart. A collection run has no url or
				// method to show, so it is named for the collection it ran
				// instead - the id if that collection has since been deleted,
				// never a blank tab, the same fallback the history row uses.
				if (run && collectionId) {
					const name =
						collections.find((c) => c.id === collectionId)?.name ?? collectionId;
					return {
						label: name,
						title: `Collection run: ${name}`,
						icon,
						isPath: false,
					};
				}
				// A design run or load test: the snapshot's method and path, the
				// same shape a request tab uses. The path comes from the stored
				// snapshot (resolved when it was sent), so it survives the
				// request being renamed or deleted.
				const snapshot = run?.configSnapshot;
				const kind = run?.type === "load" ? "Load test" : "Design run";
				const path = snapshot?.url ? pathLabel(snapshot.url) : "";
				if (run && (snapshot?.method || path)) {
					const label = path || kind;
					return {
						label,
						title: `${kind}: ${[snapshot?.method, path].filter(Boolean).join(" ")}`,
						...(snapshot?.method ? { method: snapshot.method } : {}),
						icon,
						isPath: Boolean(path),
					};
				}
				// Still loading, or a run with no snapshot to name it by.
				const fallback = run ? kind : "Run";
				return { label: fallback, title: fallback, icon };
			}
		}
	});
}

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
import {
	requestDetailOptions,
	runDetailOptions,
	useCollectionsQuery,
	useInboxesQuery,
	useMockServersQuery,
} from "@/queries";
import { collectionNamePath } from "@/modules/collections/tree-utils";
import { RUN_TYPE_NAME } from "@/modules/history/types";
import { pathLabel } from "@/lib/path-label";
import {
	collectionReference,
	inboxReference,
	mockServerReference,
	requestReference,
} from "@/lib/agent-reference";
import { loadedRunReference } from "@/lib/run-reference-input";
import { shownService } from "@/lib/shown-service";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { boundRowFor, useBoundRowStore, type Tab } from "@/stores";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import { dataFileDisplayName, dataFileFromSnapshot } from "@/lib/run-data-file";
import {
	resolveSendsUrl,
	sendsCacheInput,
	sendsResolver,
} from "@/modules/request-builder/utils/sends-url";

/**
 * Title for a request tab: the user-set name when there is one, otherwise the
 * request path. A blank or still-default placeholder name counts as "not set".
 */
export function requestTabTitle(name: string, resolvedUrl: string): string {
	const trimmed = name.trim();
	if (hasOwnName(name)) return trimmed;
	return pathLabel(resolvedUrl) || trimmed;
}

/**
 * Whether a request carries a name the user set. The one rule for when a tab
 * is titled by the request's own name and when it falls back to its URL, so
 * `fromUrl` below cannot disagree with the title it describes.
 */
export function hasOwnName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed !== "" && trimmed !== DEFAULT_REQUEST_NAME;
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
	 * True when the label was taken from a URL. Provenance, not shape: `isPath`
	 * is a display hint (a request the user named "/orders" has it), and a URL
	 * that does not parse is shown as written without a leading slash. A URL
	 * here is resolved - a secret variable's value is in it - so a surface that
	 * leaves the window (the MCP focus mirror) must not repeat such a label.
	 */
	fromUrl?: boolean;
	/**
	 * Where the request lives, as the breadcrumb reads it: its collection chain
	 * and then its own name. Request tabs only, and absent until the request has
	 * loaded - what the tab menu's "Copy path" copies (#1360).
	 *
	 * Built here rather than in the menu because this hook already holds both
	 * halves - the request and the collections list - and a menu that fetched
	 * them again would make every open tab a second subscriber to answer a
	 * question only the right-clicked one asks.
	 */
	path?: string;
	/**
	 * The entity's reference line (`lib/agent-reference.ts`), what the tab
	 * menu's and the palette's "Copy for agent" copy (#2047). Present on a tab
	 * that names an entity once that entity has loaded; absent on the welcome,
	 * settings, variables and dashboard tabs, which name none. Built here for
	 * the reason `path` is.
	 */
	agentReference?: string;
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
 *
 * **A dynamic variable in the URL (`{{$randomInt}}`, `{{$guid}}`, …) does not
 * reroll the label on every render.** `resolveString` generates such a name
 * fresh on every call (`lib/dynamic-variables.ts`'s own contract), and this
 * hook has no memoization of its own - it recomputes on every render the strip
 * takes, for any tab, not only when a URL actually changed (issue #1739).
 * `stableTitleUrl` holds the last resolved value per request id (the URL as
 * `modules/request-builder/utils/sends-url.ts` resolves it, the Params panel's
 * "Sends" line included), in the module-scope cache
 * `lib/dynamic-variable-cache.ts` describes - which is also
 * why it cannot be a `useMemo` or a `useRef` here, quite apart from the hooks
 * lint: this is a caching layer keyed on every open tab, of which there can be
 * any number, so it is not one hook's worth of state to begin with.
 */
const stableTitleUrl = createStableResolve();

export function useTabDescriptors(tabs: Tab[]): TabDescriptor[] {
	const requests = useQueries({
		queries: tabs.map((t) => requestDetailOptions(t.type === "request" ? t.entityId : null)),
	});
	const runs = useQueries({
		queries: tabs.map((t) => runDetailOptions(t.type === "run" ? t.entityId : null)),
	});
	const { data: collections = [] } = useCollectionsQuery();
	// Gated on an open tab of the kind: every surface that mounts this hook
	// would otherwise keep a service poll alive for the app's whole life.
	const { data: inboxes = [] } = useInboxesQuery({
		enabled: tabs.some((t) => t.type === "inbox"),
	});
	const { data: mocks = [] } = useMockServersQuery({
		enabled: tabs.some((t) => t.type === "mock-server"),
	});
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
		// Which file drove the run (#2051), for the tooltip only: the label is
		// the run's identity and a file name does not belong in it.
		const dataFile = dataFileFromSnapshot(run?.configSnapshot);
		const withDataFile = (title: string) =>
			dataFile
				? `${title} · ${dataFileDisplayName(dataFile.fileName, dataFile.castNumbers)}`
				: title;
		const icon = iconForTab(tab, run?.type, Boolean(collectionId));
		const runLine = run ? loadedRunReference(run, collections) : undefined;

		switch (tab.type) {
			case "welcome":
				return { label: "Vayu", title: "Vayu" };
			case "settings":
				return { label: "Settings", title: "Settings", icon };
			case "variables":
				return { label: "Variables", title: "Variables", icon };
			case "inbox": {
				// A tab with no address shows the lowest-port inbox, and so names it.
				const inbox = shownService(inboxes, (i) => i.inboxId === tab.entityId);
				return {
					label: "Inbox",
					title: "Webhook inbox",
					icon,
					agentReference: inbox ? inboxReference(inbox) : undefined,
				};
			}
			case "mock-server": {
				const mock = shownService(mocks, (m) => m.mockId === tab.entityId);
				return {
					label: "Mock server",
					title: "Mock server",
					icon,
					agentReference: mock ? mockServerReference(mock) : undefined,
				};
			}
			case "dashboard":
				return { label: "Load test", title: "Load test", icon };
			case "collection": {
				const collection = collections.find((c) => c.id === tab.entityId);
				const name = collection?.name ?? "Collection";
				return {
					label: name,
					title: name,
					icon,
					agentReference: collection
						? collectionReference(
								collection,
								collection.parentId
									? collectionNamePath(collection.parentId, collections)
									: []
							)
						: undefined,
				};
			}
			case "request": {
				if (!request) return { label: "Request", title: "Request" };
				const row = boundRowFor(bound, tab.entityId);
				// The URL as the Params panel's "Sends" line draws it (path rows,
				// encoding), so the tab and the line cannot disagree.
				// A per-call `row` (Send-with-row) is a one-off preview of a specific
				// row's bind, not this tab's own steady-state label, so it skips the
				// cache and always resolves fresh - the same reasoning `resolveString`
				// callers elsewhere apply (see `useVariableResolver`).
				const resolvedUrl = row
					? resolveSendsUrl(request, (text) => resolveString(text, row))
					: stableTitleUrl(
							request.id ?? tab.entityId ?? "",
							sendsCacheInput(request),
							sendsResolver(resolveString)
						);
				const name = requestTabTitle(request.name, resolvedUrl);
				const chain = collectionNamePath(request.collectionId, collections);
				return {
					label: name,
					title: `${request.method} ${name}`,
					method: request.method,
					// A request with no name of its own falls back to its path, so
					// path labels are not confined to run tabs.
					isPath: name.startsWith("/"),
					fromUrl: !hasOwnName(request.name),
					path: [...chain, name].join(" / "),
					// The request's own name, never `name` above: an unnamed
					// request's title is its resolved URL, which can hold a secret.
					agentReference: requestReference(request, chain),
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
						title: withDataFile(`Collection run: ${name}`),
						icon,
						isPath: false,
						agentReference: runLine,
					};
				}
				// A design run or load test: the snapshot's method and path, the
				// same shape a request tab uses. The path comes from the stored
				// snapshot (resolved when it was sent), so it survives the
				// request being renamed or deleted.
				const snapshot = run?.configSnapshot;
				const kind = run ? RUN_TYPE_NAME[run.type] : "Run";
				const path = snapshot?.url ? pathLabel(snapshot.url) : "";
				if (run && (snapshot?.method || path)) {
					const label = path || kind;
					return {
						label,
						title: withDataFile(
							`${kind}: ${[snapshot?.method, path].filter(Boolean).join(" ")}`
						),
						...(snapshot?.method ? { method: snapshot.method } : {}),
						icon,
						isPath: Boolean(path),
						fromUrl: Boolean(path),
						agentReference: runLine,
					};
				}
				// Still loading, or a run with no snapshot to name it by.
				return { label: kind, title: kind, icon, agentReference: runLine };
			}
		}
	});
}

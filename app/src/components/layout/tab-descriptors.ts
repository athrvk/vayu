/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What every open tab is called, and which glyph carries its kind. Beside `TabStrip`, not inside
 * it, because the command palette lists open tabs too: "GET /v1/orders" in the strip and "Request"
 * in the palette would be two answers to one question, and a hand-rolled copy would never receive
 * this file's fixes.
 */

// `Zap` is the load-test mark, which is what the bolt means throughout the app. `Braces` is the
// variables mark (see `constants/drawer-views.ts`).
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
import { hasOwnName, requestTabTitle } from "@/lib/request-title";
import { boundRowFor, useBoundRowStore, useSessionStore, type Tab } from "@/stores";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import { dataFileDisplayName, dataFileFromSnapshot } from "@/lib/run-data-file";
import {
	deferredNamesInSends,
	resolveSendsUrl,
	sendsCacheInput,
	sendsResolver,
	type SendsResolved,
} from "@/modules/request-builder/utils/sends-url";
import { compositionOptions } from "./context-bar/code-composition";

/**
 * What a tab draws, resolved from the store plus whatever queries name it. Split from rendering so
 * the strip can measure a tab without laying it out (see tab-fit.ts: measuring the DOM would be
 * circular).
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
	 * True when the label was taken from a URL. Provenance, not shape: `isPath` is a display hint
	 * (a request the user named "/orders" has it), and a URL that does not parse is shown as
	 * written, with no leading slash. A URL here is resolved, so it can hold a secret variable's
	 * value: a surface that leaves the window (the MCP focus mirror) must not repeat such a label.
	 */
	fromUrl?: boolean;
	/**
	 * Where the request lives, as the breadcrumb reads it: its collection chain and then its own
	 * name. Request tabs only, absent until the request has loaded; what the tab menu's "Copy path"
	 * copies (#1360). Built here, not in the menu: this hook already holds the request and the
	 * collections list, and a menu fetching them again would make every open tab a second
	 * subscriber to a question only the right-clicked one asks.
	 */
	path?: string;
	/**
	 * The entity's reference line (`lib/agent-reference.ts`), what the tab menu's and the palette's
	 * "Copy for agent" copy (#2047). Present on a tab naming an entity once that entity has loaded;
	 * absent on the welcome, settings, variables and dashboard tabs, which name none. Built here
	 * for the reason `path` is.
	 */
	agentReference?: string;
}

/**
 * Icons carry the tab's *kind*; the rail carries its method, which frees the icon to say which kind
 * of run a run is. A finished load test takes the live dashboard's `Zap`: it is the same thing at a
 * later time.
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
			// A collection run's work is a sequence, a plain collection tab's identity, so it takes
			// that tab's icon, not the load/design pair below, which both mean "one request".
			return isCollectionRun ? Folder : runType === "load" ? Zap : Clock;
		case "variables":
			// The ActivityRail and the welcome Launcher open this view from a `Braces` control, so
			// the tab carries it too, or the glyph the user pressed vanishes on arrival. See
			// `constants/drawer-views.ts`.
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
 * Resolves what every open tab is called, in one hook for the whole list: the strip must know each
 * label *before* it can decide how many fit, and a hook inside a map is a variable number of hooks.
 * `useQueries` is the supported primitive for a dynamic list, fed the options objects
 * `useRequestQuery` and `useRunQuery` use, so the retry and 404 rules are not restated here.
 *
 * **Each request resolves in its own collection's scope** (`scopedResolverFor` below), so an
 * unnamed request whose URL uses a collection-scoped variable shows the concrete path even when
 * that collection is not the session's active one.
 *
 * **A dynamic variable in the URL (`{{$randomInt}}`, `{{$guid}}`, …) does not reroll the label on
 * every render.** `resolveString` generates such a value fresh on every call
 * (`lib/dynamic-variables.ts`'s contract), and this hook recomputes on every render of the strip,
 * for any tab, not only when a URL changed (#1739). `stableTitleUrl` holds the last resolved value
 * per request id (the URL as `modules/request-builder/utils/sends-url.ts` resolves it, the Params
 * panel's "Sends" line included) in the module-scope cache `lib/dynamic-variable-cache.ts`
 * describes. Not a `useMemo` or a `useRef`, hooks lint aside: it is keyed on every open tab, any
 * number of them, not one hook's worth of state.
 */
const stableTitleUrl = createStableResolve<SendsResolved>();

/**
 * The names a pre-request script sets at send, for each request tab, read from the compose cache
 * and never fetched (#2741): this hook serves every open tab and the palette, and a compose per tab
 * is the cost #1310 removed. An entry exists once the Params panel or the Code section has asked
 * for the request, so a tab nobody has opened keeps the stored URL in its title until then. Both
 * entries are read, the editor's first: only the active tab holds the editor, and the entry
 * composed there is the better answer for a tab the user has since left.
 */
function useCachedDeferredNames(tabs: Tab[]): Map<string, readonly string[]> {
	const environmentId = useSessionStore((s) => s.activeEnvironmentId);
	const requestTabs = tabs.filter((t) => t.type === "request" && t.entityId);
	const entries = useQueries({
		queries: requestTabs.flatMap((t) =>
			[true, false].map((editorHeld) => ({
				...compositionOptions(t.entityId ?? "", environmentId, editorHeld),
				enabled: false,
			}))
		),
	});
	const names = new Map<string, readonly string[]>();
	requestTabs.forEach((t, i) => {
		const composition = entries[2 * i]?.data ?? entries[2 * i + 1]?.data;
		if (composition) names.set(t.id, composition.deferredVariables);
	});
	return names;
}

/*
 * One resolver per (`resolveString`, collection scope). `sendsResolver` and the
 * title cache key on the resolver's identity, so a closure built per render
 * would reroll every dynamic variable in a title on each one.
 */
const scopedResolvers = new WeakMap<
	(input: string, row?: undefined, collectionId?: string) => string,
	Map<string | undefined, (text: string) => string>
>();
function scopedResolverFor(
	resolveString: (input: string, row?: undefined, collectionId?: string) => string,
	collectionId: string | undefined
): (text: string) => string {
	let byScope = scopedResolvers.get(resolveString);
	if (!byScope) scopedResolvers.set(resolveString, (byScope = new Map()));
	let resolver = byScope.get(collectionId);
	if (!resolver) {
		resolver = (text) => resolveString(text, undefined, collectionId);
		byScope.set(collectionId, resolver);
	}
	return resolver;
}

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
	const scopedResolver = (collectionId: string | undefined) =>
		scopedResolverFor(resolveString, collectionId);
	/*
	 * The row the open builder is bound to (#1074). One resolver serves the whole list, so the row
	 * is not an option on it, as inside the builder, but passed per call for the one tab it belongs
	 * to. Null for every ordinary Send.
	 */
	const bound = useBoundRowStore((s) => s.bound);
	const deferredByTab = useCachedDeferredNames(tabs);

	return tabs.map((tab, i) => {
		const request = requests[i]?.data;
		const run = runs[i]?.data;
		/*
		 * A collection run has no url or method (its work is a sequence), so it is read off the
		 * snapshot's own scenario manifest, the full shape `configSnapshot` carries
		 * (`GET /runs/:id`), unlike the list row's derived `summary.scenario`. Read wherever the
		 * manifest is present, not gated on `run.type === "scenario"`: a scenario *load* run (#357)
		 * is `type: "load"` but has no url/method of its own, the reason the history row reads its
		 * descriptor the same way.
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
				// The URL as the Params panel's "Sends" line draws it (path rows, encoding), so the
				// tab and the line cannot disagree. A per-call `row` (Send-with-row) is a one-off
				// preview of one row's bind, not this tab's steady-state label, so it skips the
				// cache and resolves fresh, as `resolveString` callers elsewhere do (see
				// `useVariableResolver`). A name a pre-request script sets at send stays written in
				// it, as on the line (#2741); the cache input holds those names, so a changed
				// answer re-resolves and nothing else rerolls a generator.
				//
				// Without the auth, the method and the body (#3425, #3437): what they add to the
				// query (an API key, an OAuth 2.0 token, a GraphQL GET's document) is on the line
				// but never in a title. Named field by field because the whole request would carry
				// them.
				const sends = {
					url: request.url,
					params: request.params,
					disableUrlEncoding: request.disableUrlEncoding,
				};
				const deferred = deferredNamesInSends(sends, deferredByTab.get(tab.id) ?? []);
				const resolvedUrl = row
					? resolveSendsUrl(
							sends,
							(text) => resolveString(text, row, request.collectionId ?? undefined),
							deferred
						)
					: stableTitleUrl(
							request.id ?? tab.entityId ?? "",
							sendsCacheInput(sends, deferred),
							sendsResolver(scopedResolver(request.collectionId ?? undefined))
						).url;
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
				// A run tab is a past design run, load test or collection run. A collection run has
				// no url or method to show, so it is named for the collection it ran, or its id if
				// that collection has since been deleted, never a blank tab: the fallback the
				// history row uses.
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
				// A design run or load test: the snapshot's method and path, the shape a request
				// tab uses. The path comes from the stored snapshot (resolved when sent), so it
				// survives the request being renamed or deleted.
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

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which sections the context bar renders, and for which tabs. One list, read by the bar (what to
 * draw) and the ContextRail (which glyphs to show, and whether to show at all), both through
 * `contextBarHasContent` and `sectionsForTab`: keeping two readers in step by hand is the "config
 * one branch defines and another re-derives inline" defect.
 *
 * `appliesTo` is a pure, synchronous function of the tab and nothing else, because both call it on
 * every render, and a predicate that read a query could not be called there at all (#1310). So the
 * data-level question has a second, orthogonal answer rather than a wider `appliesTo`:
 * `useRelevance`, a hook a section opts into, called from a component per section by the bar and
 * the rail, never from the structural check. Structure stays cheap and answerable anywhere;
 * relevance costs what the section already spends. See `types.ts` for the contract.
 */

import { lazy } from "react";
import {
	Braces,
	Code2,
	Cookie,
	FileText,
	FolderOpen,
	History,
	KeyRound,
	PlayCircle,
	Settings2,
	Share2,
} from "lucide-react";
import type { Tab } from "@/stores";
import { AuthContextSection } from "./AuthContextSection";
import { CodeSection } from "./CodeSection";
import { CollectionAuthSection } from "./CollectionAuthSection";
import { CollectionContentsSection } from "./CollectionContentsSection";
import { CollectionLastRunSection } from "./CollectionLastRunSection";
import { CollectionVariablesSection } from "./CollectionVariablesSection";
import { CookiesSection } from "./CookiesSection";
import { RecentSendsSection } from "./RecentSendsSection";
import {
	useCookiesRelevance,
	useGraphQLRelevance,
	useRecentSendsRelevance,
	useVariablesRelevance,
} from "./relevance";
import { RunConfigSection } from "./RunConfigSection";
import { RunSourceSection } from "./RunSourceSection";
import { VariablesSection } from "./VariablesSection";
import type { ContextBarSection } from "./types";

/**
 * The one section not imported with the rest (#1146). It reaches the `graphql` package
 * (`parseGraphQLBody` and `documentOutline` need the parser, and the schema cache builds a client
 * schema), ~320KB of source, and the context bar is mounted on every tab, so eager it arrives
 * before the window can appear for everyone who has never opened a GraphQL request. `lazy` rather
 * than a narrower `appliesTo`, which sees the tab and so never a body mode: when the code loads is
 * a separate question from when the section applies.
 *
 * `useGraphQLRelevance` hides the section outright off a GraphQL body, so a REST tab never requests
 * the chunk. That hook lives in `relevance.ts`, not beside the section, because this file names it
 * eagerly: importing it from `GraphQLSection.tsx` would pull the parser into the startup chunk
 * through the back door. `startup-eager-graph.test.ts` guards both halves. `ContextBar` renders
 * each section inside a Suspense boundary, and a `LazyExoticComponent` is a `ComponentType`, so
 * nothing else in the registry's shape changes.
 */
const GraphQLSection = lazy(() =>
	import("./GraphQLSection").then((m) => ({ default: m.GraphQLSection }))
);

const onRequestTab = (tab: Tab) => tab.type === "request";

/**
 * A collection or run tab with no entity has no subject: `Shell` renders nothing for one, and every
 * section below would have nothing to query. Testing the entity as well as the type is why
 * `appliesTo` takes the whole tab; it also keeps the ContextRail from drawing beside an empty bar.
 */
const onCollectionTab = (tab: Tab) => tab.type === "collection" && tab.entityId !== null;
const onRunTab = (tab: Tab) => tab.type === "run" && tab.entityId !== null;

/**
 * Order is the reading order on screen: what is in scope, who you are, what rides along, how to
 * take it elsewhere, and what happened last time.
 *
 * Deliberately no "last result" section: the status, duration and age of the last send are what
 * `ResponseStatusBar` already paints in the response pane on the same screen, from the same
 * `StatusCodeBadge` and the same stored run (the builder restores that run into the pane whenever
 * nothing is in memory), and a section that never says more than the pane is a duplicate.
 * `recent-sends` below earns the slot with a *trend* across sends, which the pane cannot show; it
 * is a different section with a different id, and the guard against the old one stays.
 */
export const CONTEXT_BAR_SECTIONS: readonly ContextBarSection[] = [
	{
		// The id stays `variables` - it is the key the collapsed state persists
		// under - but the title says what the section now leads with: the variables
		// this request uses, not every name in scope (#1308).
		id: "variables",
		title: "Variables used",
		icon: Braces,
		appliesTo: onRequestTab,
		useRelevance: useVariablesRelevance,
		Component: VariablesSection,
	},
	{
		id: "auth",
		title: "Auth",
		icon: KeyRound,
		appliesTo: onRequestTab,
		Component: AuthContextSection,
	},
	{
		id: "cookies",
		title: "Cookies for this host",
		icon: Cookie,
		appliesTo: onRequestTab,
		useRelevance: useCookiesRelevance,
		Component: CookiesSection,
	},
	/*
	 * No `useRelevance`, deliberately: it is the one section whose answer costs a server round trip
	 * (`POST /compose`), so deciding whether it had anything to say would mean composing on every
	 * request tab, for a section collapsed by default. A request always composes into something, so
	 * there is no empty state to report anyway.
	 */
	{
		id: "code",
		title: "Code",
		icon: Code2,
		appliesTo: onRequestTab,
		Component: CodeSection,
	},
	{
		id: "graphql",
		title: "GraphQL",
		icon: Share2,
		appliesTo: onRequestTab,
		useRelevance: useGraphQLRelevance,
		Component: GraphQLSection,
	},
	{
		id: "recent-sends",
		title: "Recent sends",
		icon: History,
		appliesTo: onRequestTab,
		useRelevance: useRecentSendsRelevance,
		Component: RecentSendsSection,
	},

	/*
	 * The collection tab, in the request tab's reading order: what it contributes, what it hands
	 * down, how much is in it, and what happened last time. `collection-last-run` reads
	 * `GET /runs?collectionId=&limit=1` (#422), one server query for exactly the row shown.
	 */
	{
		id: "collection-variables",
		title: "Variables in this collection",
		icon: Braces,
		appliesTo: onCollectionTab,
		Component: CollectionVariablesSection,
	},
	{
		id: "collection-auth",
		title: "Auth",
		icon: KeyRound,
		appliesTo: onCollectionTab,
		Component: CollectionAuthSection,
	},
	{
		id: "collection-contents",
		title: "Contents",
		icon: FolderOpen,
		appliesTo: onCollectionTab,
		Component: CollectionContentsSection,
	},
	{
		id: "collection-last-run",
		title: "Last run",
		icon: PlayCircle,
		appliesTo: onCollectionTab,
		Component: CollectionLastRunSection,
	},

	/* The run tab: what was asked for, and what it was asked of. */
	{
		id: "run-config",
		title: "Run config",
		icon: Settings2,
		appliesTo: onRunTab,
		Component: RunConfigSection,
	},
	{
		id: "run-source",
		title: "Source",
		icon: FileText,
		appliesTo: onRunTab,
		Component: RunSourceSection,
	},
];

/** The sections that have something to say about this tab, in registry order. */
export function sectionsForTab(tab: Tab | undefined): ContextBarSection[] {
	if (!tab) return [];
	return CONTEXT_BAR_SECTIONS.filter((section) => section.appliesTo(tab));
}

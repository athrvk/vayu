/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which sections the context bar renders, and for which tabs.
 *
 * One list, read by both the bar (what to draw) and the Dock (whether the
 * toggle has anything to light up for). That is deliberate: those two used to
 * be a hardcoded `tabType === "request"` in one file and a `return null` in
 * another, and keeping them in step by hand is exactly the "config one branch
 * defines and another re-derives inline" defect the repo keeps finding.
 *
 * The collection and run sections arrived as entries in this array and nothing
 * else - no framework change, which is what the registry was for.
 *
 * `appliesTo` is still a pure, synchronous function of the tab and nothing else,
 * because the Dock's toggle calls it on every render through
 * `contextBarHasContent`, and a predicate that read a query could not be called
 * from there at all. The entry for `graphql` used to record the consequence -
 * that narrowing it to the body mode "would mean the registry could read a
 * query, which is the framework change the registry exists to avoid" - and that
 * was the right call while the bar had three sections. At seven it was not: a
 * plain REST request opened a bar in which three sections existed only to say
 * they did not apply, so the reader scanned past all seven headers to find the
 * two that meant something (#1310).
 *
 * So the data-level question got a second, orthogonal answer rather than a wider
 * `appliesTo`: `useRelevance`, a hook a section opts into, called by the bar and
 * only by the bar. Structure stays cheap and answerable anywhere; relevance
 * costs what the section already spends, and is asked only where the bar is
 * actually drawing. See `types.ts` for the contract.
 */

import { lazy } from "react";
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
 * The one section that is not imported with the rest (#1146).
 *
 * Every other section here is app code and Radix. This one reaches the
 * `graphql` package - `parseGraphQLBody` and `documentOutline` need the parser,
 * and the schema cache builds a client schema - which is ~320KB of source, and
 * the context bar is mounted on every tab, so that arrived before the window
 * could appear for everyone who has never opened a GraphQL request. `lazy`
 * rather than a narrower `appliesTo`, which sees the tab and so could never see
 * a body mode; when the section's code loads is a separate question from when
 * the section applies.
 *
 * The two now agree. `useGraphQLRelevance` hides the section outright off a
 * GraphQL body, so the chunk is not requested at all on a REST tab, where it
 * used to arrive the moment the expanded section mounted to say the request was
 * not GraphQL. That hook lives in `relevance.ts` rather than beside the section
 * precisely because this file has to name it eagerly: importing it from
 * `GraphQLSection.tsx` would pull the parser into the startup chunk through the
 * back door and undo the split. `startup-eager-graph.test.ts` guards both halves.
 *
 * `ContextBar` renders each section inside a Suspense boundary, so this needs
 * nothing else from the registry's shape - a `LazyExoticComponent` is a
 * `ComponentType`.
 */
const GraphQLSection = lazy(() =>
	import("./GraphQLSection").then((m) => ({ default: m.GraphQLSection }))
);

const onRequestTab = (tab: Tab) => tab.type === "request";

/**
 * A collection or run tab with no entity is a tab with no subject: `Shell`
 * renders nothing for one, and every section below would have nothing to query.
 * Testing the entity as well as the type is why `appliesTo` takes the whole tab
 * - it also keeps the Dock's toggle dark rather than lighting it for an empty
 * bar.
 */
const onCollectionTab = (tab: Tab) => tab.type === "collection" && tab.entityId !== null;
const onRunTab = (tab: Tab) => tab.type === "run" && tab.entityId !== null;

/**
 * Order is the reading order on screen: what is in scope, who you are, what
 * rides along, how to take it elsewhere, and what happened last time.
 *
 * There is still deliberately no "last result" section. It would show the
 * status, duration and age of the last send - which is exactly what
 * `ResponseStatusBar` already paints in the response pane on the same screen,
 * from the same `StatusCodeBadge` and the same stored run (the builder restores
 * that run into the pane whenever nothing is in memory). A section with no
 * state in which it says something the pane does not say better is a duplicate,
 * not a summary. `recent-sends` below is the version that earns the slot: a
 * *trend* across several sends, which the pane structurally cannot show. It is
 * a different section with a different id, and the guard against the old one
 * stays.
 */
export const CONTEXT_BAR_SECTIONS: readonly ContextBarSection[] = [
	{
		// The id stays `variables` - it is the key the collapsed state persists
		// under - but the title says what the section now leads with: the variables
		// this request uses, not every name in scope (#1308).
		id: "variables",
		title: "Variables used",
		appliesTo: onRequestTab,
		useRelevance: useVariablesRelevance,
		Component: VariablesSection,
	},
	{ id: "auth", title: "Auth", appliesTo: onRequestTab, Component: AuthContextSection },
	{
		id: "cookies",
		title: "Cookies for this host",
		appliesTo: onRequestTab,
		useRelevance: useCookiesRelevance,
		Component: CookiesSection,
	},
	/*
	 * No `useRelevance`, deliberately: it is the one section whose answer costs a
	 * server round trip (`POST /compose`), so a hook that decided whether it had
	 * anything to say would have to compose in order to find out - on every
	 * request tab, for a section that is collapsed by default. There is nothing
	 * to report empty anyway; a request always composes into something.
	 */
	{ id: "code", title: "Code", appliesTo: onRequestTab, Component: CodeSection },
	{
		id: "graphql",
		title: "GraphQL",
		appliesTo: onRequestTab,
		useRelevance: useGraphQLRelevance,
		Component: GraphQLSection,
	},
	{
		id: "recent-sends",
		title: "Recent sends",
		appliesTo: onRequestTab,
		useRelevance: useRecentSendsRelevance,
		Component: RecentSendsSection,
	},

	/*
	 * The collection tab, in the same reading order as the request tab above:
	 * what it contributes, what it hands down, how much is in it, and what
	 * happened last time.
	 *
	 * `collection-last-run` closes the deferral this comment used to record.
	 * It was held back twice because a collection's runs were not addressable -
	 * `GET /runs` filtered by `requestId` and a collection run links none, so
	 * the only route to the row was a substring search of every stored snapshot,
	 * a scan per open bar. `GET /runs?collectionId=&limit=1` (#422) makes it one
	 * server query for exactly the row shown.
	 */
	{
		id: "collection-variables",
		title: "Variables in this collection",
		appliesTo: onCollectionTab,
		Component: CollectionVariablesSection,
	},
	{
		id: "collection-auth",
		title: "Auth",
		appliesTo: onCollectionTab,
		Component: CollectionAuthSection,
	},
	{
		id: "collection-contents",
		title: "Contents",
		appliesTo: onCollectionTab,
		Component: CollectionContentsSection,
	},
	{
		id: "collection-last-run",
		title: "Last run",
		appliesTo: onCollectionTab,
		Component: CollectionLastRunSection,
	},

	/* The run tab: what was asked for, and what it was asked of. */
	{ id: "run-config", title: "Run config", appliesTo: onRunTab, Component: RunConfigSection },
	{ id: "run-source", title: "Source", appliesTo: onRunTab, Component: RunSourceSection },
];

/** The sections that have something to say about this tab, in registry order. */
export function sectionsForTab(tab: Tab | undefined): ContextBarSection[] {
	if (!tab) return [];
	return CONTEXT_BAR_SECTIONS.filter((section) => section.appliesTo(tab));
}

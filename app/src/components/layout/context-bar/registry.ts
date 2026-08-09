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
 */

import type { Tab } from "@/stores";
import { AuthContextSection } from "./AuthContextSection";
import { CodeSection } from "./CodeSection";
import { CollectionAuthSection } from "./CollectionAuthSection";
import { CollectionContentsSection } from "./CollectionContentsSection";
import { CollectionVariablesSection } from "./CollectionVariablesSection";
import { CookiesSection } from "./CookiesSection";
import { EnvironmentSection } from "./EnvironmentSection";
import { RecentSendsSection } from "./RecentSendsSection";
import { RunConfigSection } from "./RunConfigSection";
import { RunSourceSection } from "./RunSourceSection";
import { VariablesSection } from "./VariablesSection";
import type { ContextBarSection } from "./types";

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
		id: "variables",
		title: "Variables in scope",
		appliesTo: onRequestTab,
		Component: VariablesSection,
	},
	{ id: "auth", title: "Auth", appliesTo: onRequestTab, Component: AuthContextSection },
	{
		id: "cookies",
		title: "Cookies for this host",
		appliesTo: onRequestTab,
		Component: CookiesSection,
	},
	{ id: "code", title: "Code", appliesTo: onRequestTab, Component: CodeSection },
	{
		id: "environment",
		title: "Environment",
		appliesTo: onRequestTab,
		Component: EnvironmentSection,
	},
	{
		id: "recent-sends",
		title: "Recent sends",
		appliesTo: onRequestTab,
		Component: RecentSendsSection,
	},

	/*
	 * The collection tab, in the same reading order: what it contributes, what
	 * it hands down, then how much is in it.
	 *
	 * There is still no "last run of this collection" section now that the
	 * runner exists (#354). A collection's runs are not addressable: `GET /runs`
	 * filters by `requestId`, and a collection run's row links no request, so
	 * the only way to find one is a substring search of every stored snapshot
	 * for the collection id. A section built on that would be a scan per open
	 * bar for a number History already shows. It earns its slot once the runs
	 * list can be filtered by collection - see the note on this in #354.
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

	/* The run tab: what was asked for, and what it was asked of. */
	{ id: "run-config", title: "Run config", appliesTo: onRunTab, Component: RunConfigSection },
	{ id: "run-source", title: "Source", appliesTo: onRunTab, Component: RunSourceSection },
];

/** The sections that have something to say about this tab, in registry order. */
export function sectionsForTab(tab: Tab | undefined): ContextBarSection[] {
	if (!tab) return [];
	return CONTEXT_BAR_SECTIONS.filter((section) => section.appliesTo(tab));
}

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
 * Phase 1 is the request tab. Phase 2's collection and run sections are entries
 * in this array and nothing else - which is the point of the registry.
 */

import type { Tab } from "@/stores";
import { AuthContextSection } from "./AuthContextSection";
import { CodeSection } from "./CodeSection";
import { CookiesSection } from "./CookiesSection";
import { EnvironmentSection } from "./EnvironmentSection";
import { VariablesSection } from "./VariablesSection";
import type { ContextBarSection } from "./types";

const onRequestTab = (tab: Tab) => tab.type === "request";

/**
 * Order is the reading order on screen: what is in scope, who you are, what
 * rides along, and how to take it elsewhere.
 *
 * There is deliberately no "last result" section. It would show the status,
 * duration and age of the last send - which is exactly what `ResponseStatusBar`
 * already paints in the response pane on the same screen, from the same
 * `StatusCodeBadge` and the same stored run (the builder restores that run into
 * the pane whenever nothing is in memory). A section with no state in which it
 * says something the pane does not say better is a duplicate, not a summary.
 * The version that would earn the slot is a *trend* across recent sends, which
 * the pane structurally cannot show - see #380 for that and the engine change
 * it needs first.
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
];

/** The sections that have something to say about this tab, in registry order. */
export function sectionsForTab(tab: Tab | undefined): ContextBarSection[] {
	if (!tab) return [];
	return CONTEXT_BAR_SECTIONS.filter((section) => section.appliesTo(tab));
}

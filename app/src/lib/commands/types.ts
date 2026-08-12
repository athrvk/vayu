/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a command *is*, and what it is allowed to know.
 *
 * A command is a definition, not a component: `id`, what it reads as, and one
 * `perform`. That is what lets the palette, the native menu and (later) any
 * other surface offer the same action without each hand-rolling its own copy of
 * "what this action is" - the defect that made a menu item and a tile drift
 * apart in the first place.
 *
 * **Stores are not in the context.** They are module singletons, so a `perform`
 * reaches `useTabsStore.getState()` directly rather than being handed an
 * `openTab`. The context carries only what `getState()` cannot answer: what the
 * user is looking at, and the surfaces a caller can open.
 */

import type { LucideIcon } from "lucide-react";
import type { Tab } from "@/stores";
import type { Collection } from "@/types";

/**
 * Which palette group a command renders under.
 *
 * Two, not one: the settings roster is twelve entries wide (seven app panels
 * plus five engine categories) and would otherwise bury the five actions it
 * sits next to.
 */
export type CommandGroup = "action" | "settings";

/**
 * Dialogs and flows a command cannot open on its own.
 *
 * Everything else a `perform` needs is in a store, but a collection picker, a
 * run dialog and the theme hook are React - they exist only where something has
 * mounted them. A caller that has not (the native menu bridge) simply omits
 * this, and the commands that need it declare themselves unavailable rather
 * than throwing when picked.
 */
export interface CommandSurfaces {
	/** Create a request, asking which collection when that is ambiguous. */
	newRequest: () => void;
	/** Open the run dialog for a collection. */
	runCollection: (collection: Collection) => void;
	/** Flip the app between light and dark. */
	toggleThemeMode: () => void;
}

/**
 * What the app looks like right now, from the point of view of a command.
 *
 * Built fresh each time the roster is asked for - availability is a question
 * about this moment ("is a collection open?"), not a subscription.
 */
export interface CommandContext {
	/** The tab the user is looking at, or `null` when none is. */
	activeTab: Tab | null;
	/**
	 * How the tab strip labels that tab. From `tab-descriptors`, the hook the
	 * strip itself uses, so a command names a tab the way the tab is named.
	 */
	activeTabLabel: string | null;
	/** The collection the active tab shows, when it shows one. */
	activeCollection: Collection | null;
	surfaces?: CommandSurfaces;
}

export interface Command {
	/** Stable and unique. Used as the palette row's key and in tests. */
	id: string;
	/**
	 * What the row reads as. A function when the command names its target -
	 * "Run 'payments'" tells you what Enter will do, where "Run collection"
	 * leaves you to guess which one.
	 */
	title: string | ((ctx: CommandContext) => string);
	/** Extra match terms that do not belong on screen. Never empty. */
	keywords: readonly string[];
	group: CommandGroup;
	icon: LucideIcon;
	/** Where the row says this action already lives, when that is not obvious. */
	subtitle?: string;
	/**
	 * Whether this command can run at all right now. Omitted means always -
	 * spelled that way rather than `() => true` so the roster reads as "these
	 * five are contextual" at a glance.
	 */
	available?: (ctx: CommandContext) => boolean;
	perform: (ctx: CommandContext) => void;
}

/** The title for this moment - resolves the contextual form. */
export function commandTitle(command: Command, ctx: CommandContext): string {
	return typeof command.title === "function" ? command.title(ctx) : command.title;
}

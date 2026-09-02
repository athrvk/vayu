/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drawer's six views - their order, their names and their marks.
 *
 * The pairing `constants/shortcuts.ts` exists for, applied to the other half of
 * the same buttons. The chords were pulled out of the Dock once already,
 * because it advertised them as six independent `formatChord` literals coupled
 * to the handler by a comment; the names and icons stayed behind, and the
 * command palette needed them next (#1219). Two spellings of "Collections" with
 * two different icons is how the Dock and the palette come to disagree about
 * what the same view is called.
 *
 * The array order is the Dock strip's order and the palette's. The icon is the
 * component rather than an element, so each surface sizes it for itself.
 */

import { Braces, Clock, FolderOpen, Radio, Settings, Trash2, type LucideIcon } from "lucide-react";
import type { DrawerView } from "@/stores";

export interface DrawerViewDescriptor {
	view: DrawerView;
	/** What the button is called - the Dock's accessible name. */
	label: string;
	icon: LucideIcon;
}

export const DRAWER_VIEWS: readonly DrawerViewDescriptor[] = [
	{ view: "collections", label: "Collections", icon: FolderOpen },
	{ view: "history", label: "History", icon: Clock },
	/*
	 * `Braces`, not `Zap`. The lightning bolt is this app's load-test mark -
	 * it is the Load Test button in the URL bar, the dashboard tab icon, and
	 * the badge on a load run in History. Sitting in the Dock it said "run",
	 * which is the one thing this view does not do.
	 *
	 * `{}` is the strongest reading of "variables" here because it *is* the
	 * syntax: every variable in Vayu is written `{{name}}`, in the URL bar,
	 * in headers, in bodies, in scripts. The user has already learned the
	 * glyph before they ever look at the Dock.
	 *
	 * Rejected: `Variable` (lucide's `(x)`) is maths notation, not ours, and
	 * its centre crossing packs a 6-unit X into a 24-unit box - at 16px that
	 * is roughly 4px of detail, and it gives the icon the same
	 * round-with-something-inside silhouette as Clock and Settings.
	 * `SquareCode` (`<>` in a box) reads "script", and Vayu has real pre/post
	 * scripts to confuse it with. `Parentheses` is `Variable` minus the X:
	 * unreadable on its own, and it says "call", not "value".
	 *
	 * Distinctness in the strip: Braces is two thin open curves with a gap
	 * down the middle, the only glyph of the four that is not a closed or
	 * centre-filled shape - Collections is a solid horizontal trapezoid,
	 * History a filled circle, Settings a round cog.
	 *
	 * Kept in step with `variables/main/VariablesMain.tsx` (empty state) and
	 * `welcome/Launcher.tsx` (the Variables tile), which drew the same
	 * concept as `Variable` and `Database` respectively.
	 */
	{ view: "variables", label: "Variables", icon: Braces },
	/*
	 * `Radio`: the group is inboxes, OAuth issuers and (with #481) mock
	 * servers - things that sit there *listening*, which is what the
	 * broadcast arcs say and what none of the alternatives do. `Server`
	 * reads as a remote host, which is the thing these stand in for rather
	 * than what they are; `Play` is the load-test run mark; `Plug` reads as
	 * a connection to something else, and the point of a local service is
	 * that there is nothing else.
	 *
	 * Distinct in the strip: it is the only glyph made of concentric arcs -
	 * Collections a solid trapezoid, History a filled circle, Variables two
	 * open curves, Settings a round cog.
	 */
	{ view: "services", label: "Services", icon: Radio },
	/*
	 * `Trash2`, the same glyph every delete affordance in the app already
	 * uses - and that repetition is the argument for it rather than against
	 * it. The user meets this icon on the row action that put the item here;
	 * finding it again in the Dock is how they learn where the item went.
	 *
	 * Distinct in the strip: a tapered bin with a lid line across the top,
	 * the only glyph of the six that is wider at the shoulders than the foot
	 * - Collections a solid trapezoid, History a filled circle, Variables
	 * two open curves, Services concentric arcs, Settings a round cog.
	 */
	{ view: "trash", label: "Trash", icon: Trash2 },
	{ view: "settings", label: "Settings", icon: Settings },
];

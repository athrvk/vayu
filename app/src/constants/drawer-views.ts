/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The drawer's six views: their order, their names and their marks. The pairing
 * `constants/shortcuts.ts` exists for, applied to the other half of the same buttons: the chords
 * left the Dock once already (six independent `formatChord` literals coupled to the handler by a
 * comment), the names and icons stayed behind, and the command palette needed them next (#1219).
 * Two spellings of "Collections" with two different icons is how the Dock and the palette come to
 * disagree about what the same view is called.
 *
 * The array order is the Dock strip's order and the palette's. The icon is the component rather
 * than an element, so each surface sizes it for itself.
 */

import { Braces, Clock, FolderOpen, Radio, Settings, Trash2, type LucideIcon } from "lucide-react";
import { ICON_MOTION, type IconMotion } from "@/components/ui/icon-motion";
import type { DrawerView } from "@/stores";

export interface DrawerViewDescriptor {
	view: DrawerView;
	/** What the button is called - the Dock's accessible name. */
	label: string;
	/**
	 * A one-line gloss the rail's tooltip shows under the label, for a name that
	 * is a bare noun saying nothing of what is behind it (`docs/ux-writing.md`).
	 * Absent for a name that explains itself. Never part of the accessible name.
	 */
	hint?: string;
	icon: LucideIcon;
	/**
	 * Which named motion this view's glyph plays on hover or focus of the button it sits in, if any
	 * (#1687). The descriptor carries it so every surface drawing these six (the rail, the command
	 * palette) animates the same glyph the same way without the renderer knowing which icon it was
	 * handed.
	 *
	 * Absent is the default and means no motion, but no rail entry takes that default: a rail entry
	 * is a navigation affordance, and a glyph that means "go to History" earning nothing while
	 * Trash gets a lid is what #1707 was filed about. All six name a motion, and no two name the
	 * same one; `ActivityRail.test.tsx` holds both halves of that.
	 *
	 * History's `Clock` and Services' `Radio` animate here even though `Clock` is one of the six
	 * status glyphs. That is the refined policy, not an exception to it
	 * (docs/design-system/motion.md, Icon motion): the prohibition is on a glyph conveying a state
	 * (a chip, a status column, an inline warning), not on the glyph itself, and here it is the
	 * affordance for an action.
	 */
	motion?: IconMotion;
}

export const DRAWER_VIEWS: readonly DrawerViewDescriptor[] = [
	{ view: "collections", label: "Collections", icon: FolderOpen, motion: ICON_MOTION.tilt },
	{ view: "history", label: "History", icon: Clock, motion: ICON_MOTION.hands },
	/*
	 * `Braces`, not `Zap`: the lightning bolt is this app's load-test mark (the Load Test button in
	 * the URL bar, the dashboard tab icon, the badge on a load run in History), and in the Dock it
	 * said "run", the one thing this view does not do. `{}` is the strongest reading of "variables"
	 * because it is the syntax: every variable in Vayu is written `{{name}}`, in the URL bar,
	 * headers, bodies and scripts, so the user has learned the glyph before they look at the Dock.
	 *
	 * Rejected: `Variable` (lucide's `(x)`) is maths notation, not ours, and its centre crossing
	 * packs a 6-unit X into a 24-unit box (roughly 4px of detail at 16px), giving it the
	 * round-with-something-inside silhouette of Clock and Settings. `SquareCode` (`<>` in a box)
	 * reads "script", and Vayu has real pre/post scripts to confuse it with. `Parentheses` is
	 * `Variable` minus the X: unreadable on its own, and it says "call", not "value".
	 *
	 * Distinct in the strip: two thin open curves with a gap down the middle (Collections a solid
	 * trapezoid, History a filled circle, Services concentric arcs, Trash a lidded bin, Settings a
	 * round cog).
	 *
	 * Kept in step with `variables/main/VariablesMain.tsx` (empty state) and `welcome/Launcher.tsx`
	 * (the Variables tile).
	 */
	{ view: "variables", label: "Variables", icon: Braces, motion: ICON_MOTION.spread },
	/*
	 * `Radio`: the group is inboxes, OAuth issuers and mock servers (#481), things that sit there
	 * listening, which is what the broadcast arcs say and none of the alternatives do. `Server`
	 * reads as a remote host, the thing these stand in for rather than what they are; `Play` is the
	 * load-test run mark; `Plug` reads as a connection to something else, and the point of a local
	 * service is that there is nothing else.
	 *
	 * Distinct in the strip: the only glyph made of concentric arcs (Collections a solid trapezoid,
	 * History a filled circle, Variables two open curves, Trash a lidded bin, Settings a round
	 * cog).
	 */
	{
		view: "services",
		label: "Services",
		hint: "Webhook inbox, OAuth issuer, mock servers",
		icon: Radio,
		motion: ICON_MOTION.waves,
	},
	/*
	 * `Trash2`, the glyph every delete affordance in the app already uses, and that repetition is
	 * the argument for it: the user meets this icon on the row action that put the item here, and
	 * finding it again in the Dock is how they learn where the item went.
	 *
	 * Distinct in the strip: a tapered bin with a lid line across the top, the only glyph of the
	 * six wider at the shoulders than the foot (Collections a solid trapezoid, History a filled
	 * circle, Variables two open curves, Services concentric arcs, Settings a round cog).
	 */
	{ view: "trash", label: "Trash", icon: Trash2, motion: ICON_MOTION.lid },
	{ view: "settings", label: "Settings", icon: Settings, motion: ICON_MOTION.spinOnce },
];

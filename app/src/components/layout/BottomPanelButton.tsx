/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { SquareTerminal } from "lucide-react";
import { TooltipIconButton } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import { TOGGLE_BOTTOM_PANEL_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";

/**
 * The Dock's button for the bottom panel (#3635): always present, first in the
 * right cluster, pressed while the panel is open.
 *
 * An icon, named "Console" by its label and tooltip like the response-position
 * button beside it. The glyph is a console's prompt, what a user arriving from
 * Postman looks for in the footer (#3634), and it serves the Logs tab beside
 * the Console as well; it is not a panel, because the response position's own
 * glyphs are panels (`PanelBottom`, `PanelRight`) and a second one a few pixels
 * away reads as the same control. The name never changes with the state -
 * `aria-pressed` carries that, as the rails' buttons do.
 *
 * The chord and the palette row are the other two routes to the same store
 * action, so a macOS Dock covering this strip costs a glance, never a click.
 */
export function BottomPanelButton() {
	const open = useLayoutStore((s) => s.bottomPanelOpen);
	const toggleBottomPanel = useLayoutStore((s) => s.toggleBottomPanel);

	return (
		<TooltipIconButton
			label={BOTTOM_PANEL_LABEL}
			tooltipHint={formatChord(TOGGLE_BOTTOM_PANEL_CHORD)}
			icon={<SquareTerminal className="size-icon-sm" aria-hidden="true" />}
			aria-pressed={open}
			onClick={toggleBottomPanel}
			className="text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
		/>
	);
}

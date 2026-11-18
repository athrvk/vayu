/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { PanelBottomClose, PanelBottomOpen } from "lucide-react";
import {
	Button,
	IconSwap,
	Tooltip,
	TooltipContent,
	TooltipShortcutLabel,
	TooltipTrigger,
} from "@/components/ui";
import { useLayoutStore } from "@/stores";
import { BOTTOM_PANEL_LABEL } from "@/constants/layout";
import { TOGGLE_BOTTOM_PANEL_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";

/**
 * The Dock's button for the bottom panel (#3635): always present, at the start
 * of the right cluster, pressed while the panel is open.
 *
 * Labelled in words, unlike the response-position button beside it, because it
 * names a place the user goes to rather than flipping an arrangement. The name
 * never changes with the state - `aria-pressed` carries that, as the rails'
 * buttons do - and the glyph follows the pane-toggle rule: the one that says
 * what a click does (`docs/design-system.md`, "Pane Toggles").
 *
 * The chord and the palette row are the other two routes to the same store
 * action, so a macOS Dock covering this strip costs a glance, never a click.
 */
export function BottomPanelButton() {
	const open = useLayoutStore((s) => s.bottomPanelOpen);
	const toggleBottomPanel = useLayoutStore((s) => s.toggleBottomPanel);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					aria-pressed={open}
					onClick={toggleBottomPanel}
					className="gap-1.5 px-2 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"
				>
					<IconSwap
						state={open ? "open" : "closed"}
						icons={{
							closed: <PanelBottomOpen className="size-icon-sm" aria-hidden="true" />,
							open: <PanelBottomClose className="size-icon-sm" aria-hidden="true" />,
						}}
					/>
					{BOTTOM_PANEL_LABEL}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">
				<TooltipShortcutLabel
					label={TOGGLE_BOTTOM_PANEL_CHORD.label ?? BOTTOM_PANEL_LABEL}
					shortcut={formatChord(TOGGLE_BOTTOM_PANEL_CHORD)}
				/>
			</TooltipContent>
		</Tooltip>
	);
}

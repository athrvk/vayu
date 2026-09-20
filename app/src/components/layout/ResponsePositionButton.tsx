/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { PanelBottom, PanelRight } from "lucide-react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuTrigger,
	IconSwap,
	TooltipIconButton,
} from "@/components/ui";
import { useLayoutStore, resolveResponseArrangement, type ResponsePosition } from "@/stores";
import { RESPONSE_POSITIONS } from "@/constants/layout";
import { TOGGLE_RESPONSE_POSITION_CHORD } from "@/constants/shortcuts";
import { contextProps } from "@/lib/context-menu";
import { formatChord } from "@/lib/platform";

/**
 * The Dock's response-position switch (issue #1711): one icon button that
 * moves the response pane from beside the request to below it, and back.
 *
 * The icon names the **destination**, not the current state - the rule
 * "### Pane Toggles" in `docs/design-system.md` already holds for the
 * `PanelLeft*` pair: `PanelBottom` while the response is beside ("Response
 * below"), `PanelRight` while it is below ("Response beside"). A glyph
 * showing the current arrangement would read as a status, and this strip has
 * enough of those; a glyph showing where a click takes you is an affordance.
 *
 * While the setting is `auto` the button shows Auto's current pick and a click
 * writes an explicit Beside or Below - the user chose, so Auto is over until
 * they pick it again in Settings. `toggleResponsePosition` holds that rule so
 * the chord and the palette row cannot apply a different one.
 *
 * `IconSwap` rather than a conditional render: the two glyphs are the same
 * nominal size and still not the same width of ink, and the swap crossfades
 * where a swap-by-render pops.
 *
 * Right-click picks instead of flipping: a radio menu over the three settings
 * (Beside, Below, Auto), the same set the Settings row offers. It is what puts
 * Auto within reach from the strip - a left click can only ever leave it - and
 * it marks which of the three is in force, which the destination glyph by
 * design does not say. `contextProps("own-menu")` keeps the main process's
 * edit menu off the gesture, as on every surface that draws its own.
 */
export function ResponsePositionButton() {
	const setting = useLayoutStore((s) => s.responsePosition);
	const arrangement = useLayoutStore(resolveResponseArrangement);
	const toggleResponsePosition = useLayoutStore((s) => s.toggleResponsePosition);
	const setResponsePosition = useLayoutStore((s) => s.setResponsePosition);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<TooltipIconButton
					label={arrangement === "beside" ? "Response below" : "Response beside"}
					tooltipHint={formatChord(TOGGLE_RESPONSE_POSITION_CHORD)}
					icon={
						<IconSwap
							state={arrangement}
							icons={{
								beside: <PanelBottom className="size-icon-sm" aria-hidden="true" />,
								below: <PanelRight className="size-icon-sm" aria-hidden="true" />,
							}}
						/>
					}
					className="text-muted-foreground hover:text-foreground"
					onClick={toggleResponsePosition}
					{...contextProps("own-menu")}
				/>
			</ContextMenuTrigger>
			<ContextMenuContent aria-label="Response position">
				<ContextMenuRadioGroup
					value={setting}
					onValueChange={(value) => setResponsePosition(value as ResponsePosition)}
				>
					{RESPONSE_POSITIONS.map((option) => (
						<ContextMenuRadioItem key={option.value} value={option.value}>
							{option.label}
						</ContextMenuRadioItem>
					))}
				</ContextMenuRadioGroup>
			</ContextMenuContent>
		</ContextMenu>
	);
}

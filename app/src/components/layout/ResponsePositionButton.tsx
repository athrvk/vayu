/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { PanelBottom, PanelRight } from "lucide-react";
import { IconSwap, TooltipIconButton } from "@/components/ui";
import { useLayoutStore, resolveResponseArrangement } from "@/stores";
import { TOGGLE_RESPONSE_POSITION_CHORD } from "@/constants/shortcuts";
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
 */
export function ResponsePositionButton() {
	const arrangement = useLayoutStore(resolveResponseArrangement);
	const toggleResponsePosition = useLayoutStore((s) => s.toggleResponsePosition);

	return (
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
		/>
	);
}

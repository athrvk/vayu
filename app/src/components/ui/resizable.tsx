/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * `data-orientation` is stamped here because the library's v4 renders none: it lays the group out
 * with an inline `flex-direction` and exposes orientation only on the separator, as its own
 * (opposite) `aria-orientation`. One group attribute gives a stylesheet or test the arrangement.
 */
const ResizablePanelGroup = ({
	className,
	orientation = "horizontal",
	...props
}: React.ComponentProps<typeof Group>) => (
	<Group
		orientation={orientation}
		data-orientation={orientation}
		className={cn("flex h-full w-full", className)}
		{...props}
	/>
);

const ResizablePanel = Panel;

/**
 * The divider. Its `aria-orientation` is the separator's, not the group's: side-by-side panels have
 * a `vertical` separator, stacked ones `horizontal`, which the `aria-[orientation=horizontal]:`
 * variants style. `onReset` replaces the library's double-click reset, which restores
 * `defaultSize`, here the *persisted* ratio, so it would reset to where the user last left it. The
 * caller resets to its own neutral (the builder's even split) and writes it through, as
 * `PanelResizeHandle` does for the drawer.
 */
const ResizableHandle = ({
	withHandle,
	onReset,
	className,
	...props
}: React.ComponentProps<typeof Separator> & {
	withHandle?: boolean;
	onReset?: () => void;
}) => (
	<Separator
		className={cn(
			"relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
			"aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:after:translate-x-0 [&[aria-orientation=horizontal]>div]:rotate-90",
			className
		)}
		disableDoubleClick={onReset !== undefined || props.disableDoubleClick}
		onDoubleClick={onReset}
		{...props}
	>
		{withHandle && (
			<div className="z-10 flex h-4 w-3 items-center justify-center border bg-border">
				<GripVertical className="h-2.5 w-2.5" />
			</div>
		)}
	</Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

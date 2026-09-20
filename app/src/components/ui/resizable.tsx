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
 * `data-orientation` is stamped here because v4 of the library renders none:
 * it lays the group out with an inline `flex-direction` and exposes the
 * orientation on the separator alone, as `aria-orientation` (the separator's
 * own, which is the opposite word). One attribute on the group is what a
 * stylesheet or a test can read the arrangement from.
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
 * The divider. Its own `aria-orientation` is the separator's, not the group's:
 * a group laying its panels side by side has a separator that runs top to
 * bottom (`vertical`), and a stacked group has one that runs across
 * (`horizontal`), which is what the `aria-[orientation=horizontal]:` variants
 * below style.
 *
 * `onReset` runs on double-click in place of the library's own reset, which
 * puts the panels back at their `defaultSize` - the *persisted* ratio here,
 * so on its own a double-click would reset to wherever the user last left the
 * divider. The caller resets to its own idea of neutral (the builder's is an
 * even split) and writes that through, the same behaviour
 * `PanelResizeHandle` gives the drawer's handle.
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

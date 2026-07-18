/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SettingsLayout
 *
 * The settings screen's two-pane layout: a resizable category sidebar and the
 * settings content. Extracted from Shell so the drag-to-resize hook has a
 * component to live in. Width is drag-adjustable (delta-based useResizable) so
 * long category labels aren't stuck truncated at a fixed width.
 */

import { cn } from "@/lib/utils";
import { useResizable } from "@/hooks/useResizable";
import SettingsCategoryTree from "../sidebar/SettingsCategoryTree";
import SettingsMain from "./SettingsMain";

export default function SettingsLayout() {
	const { size, isResizing, startResizing } = useResizable({
		defaultSize: 256,
		min: 200,
		max: 440,
	});

	return (
		<div className="flex flex-1 min-w-0 h-full overflow-hidden">
			<div
				style={{ width: `${size}px` }}
				className="shrink-0 border-r border-border bg-panel overflow-y-auto"
			>
				<SettingsCategoryTree />
			</div>
			<div
				onMouseDown={startResizing}
				role="separator"
				aria-orientation="vertical"
				className={cn(
					"w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary",
					isResizing && "bg-primary"
				)}
			/>
			<SettingsMain />
		</div>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";

/**
 * One figure over its caption, the tile both stream surfaces use: the finished
 * report's {@link StreamMetrics} and the live view's `LiveStreamPanel`. The
 * caption is a node so a tile can carry its own `InfoChip`.
 */
export function StreamStat({
	label,
	value,
	emphasis,
}: {
	label: ReactNode;
	value: string;
	emphasis?: boolean;
}) {
	return (
		<div>
			<div
				className={
					emphasis
						? "text-sm font-semibold text-foreground font-mono tabular-nums"
						: "text-sm text-foreground font-mono tabular-nums"
				}
			>
				{value}
			</div>
			<div className="text-micro text-muted-foreground">{label}</div>
		</div>
	);
}

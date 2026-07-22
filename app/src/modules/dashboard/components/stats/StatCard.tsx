/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InfoChip, EYEBROW_CLASS } from "../shared";

/** Secondary metric pattern (22px values) - one Row 4 stat. */
export function StatCard({
	label,
	value,
	unit,
	sub,
	infoTip,
}: {
	label: string;
	value: ReactNode;
	unit?: string;
	sub?: ReactNode;
	infoTip?: ReactNode;
}) {
	return (
		<div className="bg-card border border-border rounded-md p-3">
			<p className={cn(EYEBROW_CLASS, "mb-1.5")}>
				{label}
				{infoTip && <InfoChip tip={infoTip} />}
			</p>
			<div className="flex items-baseline gap-1">
				<span className="text-[22px] font-bold font-mono tabular-nums text-foreground leading-none">
					{value}
				</span>
				{unit && <span className="text-xs text-muted-foreground">{unit}</span>}
			</div>
			{sub && <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">{sub}</div>}
		</div>
	);
}

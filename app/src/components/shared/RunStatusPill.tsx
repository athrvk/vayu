/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Run } from "@/types";
import { RUN_STATUS } from "./run-status";

interface RunStatusProps {
	status: Run["status"];
	className?: string;
}

/**
 * The status glyph on its own, for a row too dense for a word. Decorative:
 * whatever hosts it states the status in words (the row's accessible name).
 */
export function RunStatusGlyph({ status, className }: RunStatusProps) {
	const { icon: Icon, text, spin } = RUN_STATUS[status];
	return <Icon className={cn(text, spin && "animate-spin", className)} aria-hidden="true" />;
}

/**
 * A run's status as a word and a glyph, tinted by the status family. `chip`
 * because the pill paints its own background (see `badge-variants.ts`).
 */
export function RunStatusPill({ status, className }: RunStatusProps) {
	const { label, text, tint } = RUN_STATUS[status];
	return (
		<Badge
			variant="chip"
			data-status={status}
			className={cn(
				"shrink-0 gap-1.5 px-2 py-0.5 text-label tracking-wide",
				tint,
				text,
				className
			)}
		>
			<RunStatusGlyph status={status} className="size-3 shrink-0" />
			{label}
		</Badge>
	);
}

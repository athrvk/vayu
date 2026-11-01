/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cn } from "@/lib/utils";

/**
 * The gutter beside a log line: a word naming the level (or the kind, for an
 * element's message), right-aligned in a column that is reserved even when the
 * word is blank so the text beside it stays aligned. A span, not an icon -
 * console output is unbounded and a per-row SVG is the dominant render cost.
 */
export function LogGutter({ label, labelClassName }: { label: string; labelClassName: string }) {
	return (
		<span
			aria-hidden={label === "" ? true : undefined}
			className={cn(
				"w-9 shrink-0 select-none text-right text-micro uppercase leading-5 tracking-wide",
				labelClassName
			)}
		>
			{label}
		</span>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MethodBadge
 *
 * The single way to display an HTTP method. It previously rendered seven
 * different ways across the app — three sizes, two weights, some tinted, some
 * with no colour at all — and the history sidebar carried its own copy of the
 * colour logic that omitted `getMethodColor`'s fallback, so an unrecognised
 * method resolved to an undefined custom property and silently lost its colour.
 *
 * Method colour is one of the app's strongest visual signals; it should mean the
 * same thing everywhere it appears.
 */

import { getMethodColor } from "@/utils";
import { cn } from "@/lib/utils";

interface MethodBadgeProps {
	method: string;
	/**
	 * `badge` — tinted chip, for list rows and headers where it anchors a line.
	 * `text` — colour only, for dense places (tabs) where chrome would crowd.
	 */
	variant?: "badge" | "text";
	/** 10px for dense rows, 11px where it sits beside body text. */
	size?: "sm" | "md";
	/** Dim in secondary contexts — e.g. an inactive tab. */
	muted?: boolean;
	className?: string;
}

export function MethodBadge({
	method,
	variant = "badge",
	size = "sm",
	muted = false,
	className,
}: MethodBadgeProps) {
	const c = getMethodColor(method);

	return (
		<span
			className={cn(
				"font-mono font-semibold uppercase shrink-0 transition-opacity",
				size === "sm" ? "text-[10px]" : "text-[11px]",
				variant === "badge" && "rounded-md border px-1.5 py-0.5",
				muted && "opacity-60",
				className
			)}
			style={
				variant === "badge"
					? {
							color: `hsl(${c})`,
							background: `hsl(${c} / 0.1)`,
							borderColor: `hsl(${c} / 0.3)`,
						}
					: { color: `hsl(${c})` }
			}
		>
			{method.toUpperCase()}
		</span>
	);
}

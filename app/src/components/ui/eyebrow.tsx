/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The small-caps label above a group ("Resolution chain", "Request timing", "Response Headers"),
 * importable from anywhere: the constant once lived in `modules/dashboard/components/shared.tsx`,
 * out of reach of `components/shared/`, so other surfaces re-typed it and drifted
 * (`HeadersViewer`'s two were neither the app's 11px). `eyebrow.test.ts` (#1692) fails on the
 * *shape*: no `.tsx` outside this file combines `uppercase` with a `tracking-` utility in one class
 * string, bar a short list exempted there by name for labels that are not section labels.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Everything but the size, which is what the two steps differ in. */
const EYEBROW_BASE = "font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/** 11px, semibold, uppercase, loosely tracked, muted. */
export const EYEBROW_CLASS = `text-label ${EYEBROW_BASE}`;

/**
 * The same label a step down (#1692), for the denser 10px tier panes had hand-rolled (Collection
 * Detail's captions, `ChainCard`, test-result group headings, the throughput twin's legends, the
 * variable popover's origin headings): eyebrows in every other respect, so the size is a prop. The
 * tracking is `0.06em` in both, ending the five values the copies ran.
 */
export const EYEBROW_XS_CLASS = `text-micro ${EYEBROW_BASE}`;

export function Eyebrow({
	children,
	className,
	size = "sm",
}: {
	children: ReactNode;
	className?: string;
	/** `sm` is the 11px step, `xs` the 10px one. */
	size?: "sm" | "xs";
}) {
	// `data-slot`, as the Card primitives carry: the stable way to ask what a block calls itself
	// without matching classes. `app-settings.drift.test.tsx` reads it to compare a settings
	// block's heading with the name search offers.
	return (
		<p
			data-slot="eyebrow"
			data-size={size}
			className={cn(size === "xs" ? EYEBROW_XS_CLASS : EYEBROW_CLASS, className)}
		>
			{children}
		</p>
	);
}

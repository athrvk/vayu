/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The small-caps label above a group: "Resolution chain", "Request timing",
 * "Response Headers".
 *
 * The class string it holds is typed out by hand in roughly a dozen components,
 * and a constant for it already existed - in `modules/dashboard/components/
 * shared.tsx`, where only the dashboard could reach it without importing a
 * module from `components/shared/`, which is the wrong direction. So the app had
 * one definition nobody outside its own folder could use, and every other
 * surface re-typed the value.
 *
 * That is how the two in `HeadersViewer` drifted: one was `text-sm ...
 * tracking-wide` and the other `text-xs ... uppercase`, neither of them the
 * 11px the rest of the app uses.
 *
 * Living here, it is importable from anywhere. The remaining hand-typed copies
 * were swept in #1692, and `eyebrow.test.ts` now fails on the *shape* rather
 * than on a verbatim copy: no `.tsx` outside this file combines `uppercase`
 * with a `tracking-` utility in one class string, bar a short list of files
 * exempted there by name for labels that are not section labels.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Everything but the size, which is what the two steps differ in. */
const EYEBROW_BASE = "font-semibold uppercase tracking-[0.06em] text-muted-foreground";

/** 11px, semibold, uppercase, loosely tracked, muted. */
export const EYEBROW_CLASS = `text-label ${EYEBROW_BASE}`;

/**
 * The same label one step down (#1692).
 *
 * Several panes ran a denser 10px tier hand-rolled - Collection Detail's field
 * and stat captions, `ChainCard`, the test-result group headings, the
 * throughput twin's legends, the variable popover's origin headings. They are
 * eyebrows in every other respect, so the size is a prop rather than a reason
 * to keep a second class string alive. Tracking is `0.06em` in both: the
 * hand-rolled copies ran five different values between them, which is the drift
 * this primitive exists to end.
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
	// `data-slot`, as the Card primitives carry: it is the only stable way to ask
	// "what does this block call itself" without matching on the class string.
	// `app-settings.drift.test.tsx` reads it to compare a settings block's
	// heading against the name search offers for it.
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

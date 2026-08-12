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
 * are a separate sweep - this file only claims the ones it is used by.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 11px, semibold, uppercase, loosely tracked, muted. */
export const EYEBROW_CLASS =
	"text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
	// `data-slot`, as the Card primitives carry: it is the only stable way to ask
	// "what does this block call itself" without matching on the class string.
	// `app-settings.drift.test.tsx` reads it to compare a settings block's
	// heading against the name search offers for it.
	return (
		<p data-slot="eyebrow" className={cn(EYEBROW_CLASS, className)}>
			{children}
		</p>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One notice treatment for the whole app.
 *
 * The load-test dialog alone had five, including two warning styles that did
 * not match each other (`border-warning/30 bg-warning/10` against
 * `border-warning/40 bg-warning/5`), and the MCP settings panel had the same
 * two variants again. They are all this shape: an icon, a line of text, and
 * sometimes an action.
 *
 * Up to four can be on screen at once where the conditions are independent -
 * in the load-test dialog a ramp error, a pre-request script and an OAuth
 * warning all stack.
 *
 * With that many, the only thing telling the user which notice is *stopping*
 * them is order and weight, so severity is a prop and the caller sorts on it.
 */

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Severity } from "./callout-severity";

const STYLES: Record<Severity, { box: string; icon: string; Icon: typeof AlertTriangle }> = {
	// Destructive tokens, not warning ones: this is the tier that disables Start,
	// and it has to outrank the advisory notice sitting next to it.
	blocking: {
		box: "border-destructive/40 bg-destructive/10",
		icon: "text-destructive-text",
		Icon: AlertTriangle,
	},
	warning: {
		box: "border-warning/40 bg-warning/10",
		icon: "text-warning-text",
		Icon: AlertTriangle,
	},
	info: { box: "border-border bg-panel", icon: "text-muted-foreground", Icon: Info },
};

export interface CalloutProps {
	severity: Severity;
	/** Bolded lead-in. The rest of the sentence continues after it. */
	title?: ReactNode;
	children?: ReactNode;
	/** Rendered to the right - a Refresh button, an override switch. */
	action?: ReactNode;
	/** Swaps the icon for a tick. Only meaningful on `info`. */
	positive?: boolean;
	className?: string;
}

export function Callout({ severity, title, children, action, positive, className }: CalloutProps) {
	const style = STYLES[severity];
	const Icon = positive ? CheckCircle2 : style.Icon;

	return (
		<div
			className={cn(
				"flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[12px] leading-relaxed",
				style.box,
				className
			)}
		>
			<Icon
				className={cn(
					"h-4 w-4 shrink-0 mt-px",
					positive ? "text-status-success-text" : style.icon
				)}
				aria-hidden="true"
			/>
			<div className="flex-1 min-w-0 text-foreground">
				{title && <span className="font-semibold">{title}</span>}
				{title && children ? " - " : null}
				{children}
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

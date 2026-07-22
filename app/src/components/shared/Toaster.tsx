/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toaster
 *
 * Renders the transient notifications queued in the toast-store as a bottom-right
 * stack. Styled with design tokens so it follows the active theme.
 *
 * Accessibility - the viewport/toast split (mirrors Radix Toast and sonner):
 *
 * The outer container is a *persistent viewport*. It renders even with zero
 * toasts, because a live region has to already be in the DOM for assistive tech
 * to observe a change to it; a region that appears together with its content is
 * commonly not announced at all. So the live semantics (`role="status"` +
 * `aria-live="polite"`) live on the container, and the individual toasts carry
 * none - a live region nested inside a live region is its own bug.
 *
 * `aria-atomic="false"` is set explicitly, and has to be. ARIA gives
 * `role="status"` an implicit `aria-atomic="true"`, so leaving the attribute off
 * does not leave it false - Chrome's accessibility tree reported the region as
 * `status atomic live="polite"` with no attribute present, and adding
 * `aria-atomic="false"` was what removed it. Atomic here would re-announce the
 * whole stack every time a single toast arrives.
 *
 * Everything is polite, nothing is assertive. Routing error toasts to a second
 * `role="alert"` region was considered and rejected: a toast auto-dismisses on a
 * timer, so interrupting whatever the user is currently reading is the wrong
 * trade, and every toast here reports the outcome of an action the user just
 * took - they are already waiting for the answer.
 *
 * The empty viewport still occupies its fixed bottom-right box, so it is
 * `pointer-events-none` and each toast re-enables `pointer-events-auto`;
 * otherwise it would sit invisibly over that corner of the app.
 */

import { X } from "lucide-react";
import { useToastStore } from "@/stores";
import { cn } from "@/lib/utils";

export default function Toaster() {
	const { toasts, dismissToast } = useToastStore();

	return (
		<div
			role="status"
			aria-live="polite"
			aria-atomic="false"
			className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]"
		>
			{toasts.map((toast) => (
				<div
					key={toast.id}
					className={cn(
						"pointer-events-auto flex items-start gap-2 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-lg",
						toast.variant === "error" && "border-destructive/40",
						toast.variant === "success" && "border-status-success/40",
						toast.variant === "info" && "border-border"
					)}
				>
					<span className="flex-1 text-sm leading-snug">{toast.message}</span>
					<button
						onClick={() => dismissToast(toast.id)}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Dismiss notification"
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}

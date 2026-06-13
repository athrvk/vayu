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
 */

import { X } from "lucide-react";
import { useToastStore } from "@/stores";
import { cn } from "@/lib/utils";

export default function Toaster() {
	const { toasts, dismissToast } = useToastStore();

	if (toasts.length === 0) return null;

	return (
		<div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
			{toasts.map((toast) => (
				<div
					key={toast.id}
					role="status"
					className={cn(
						"flex items-start gap-2 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-lg",
						toast.variant === "error" && "border-destructive/40",
						toast.variant === "success" && "border-green-500/40",
						toast.variant === "info" && "border-border"
					)}
				>
					<span className="flex-1 text-sm leading-snug">{toast.message}</span>
					<button
						onClick={() => dismissToast(toast.id)}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Dismiss notification"
					>
						<X size={14} />
					</button>
				</div>
			))}
		</div>
	);
}

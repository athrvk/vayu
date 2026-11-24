/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Renders `stores/toast-store.ts`'s queue through `components/ui/toast.tsx`'s Radix primitive,
 * mounted once in `App.tsx`.
 *
 * Accessibility: a live region first appearing with its content is commonly not announced. Radix
 * gives *each* toast its own visually hidden `role="status" aria-live="polite"` region, mounted
 * **empty** with the text injected a frame later (verified on the rendered DOM), so the region
 * pre-exists its content; and as each holds one toast, not the stack, the implicit
 * `aria-atomic="true"` is correct. Everything is polite, nothing assertive (`type="background"`,
 * argued in `ui/toast.tsx`).
 *
 * `ToastProvider` gives the viewport a hotkey, F8 by default, that moves focus into the stack, and
 * advertises it in the viewport's accessible name ("Notifications (F8)", Radix's default, confirmed
 * in the browser). The app does not bind it, only lists it (`FOCUS_NOTIFICATIONS_CHORD`, #3498).
 * The `label` passed here prefixes the announced text; the region name comes from `ToastViewport`'s
 * own `label`.
 */

import {
	Toast,
	ToastAction,
	ToastClose,
	ToastDescription,
	ToastIcon,
	ToastProvider,
	ToastTitle,
	ToastViewport,
} from "@/components/ui/toast";
import { useToastStore, useClientSettingsStore } from "@/stores";
import { toastPositionOption } from "@/constants/toast";

export default function Toaster() {
	const toasts = useToastStore((s) => s.toasts);
	const dismissToast = useToastStore((s) => s.dismissToast);
	/*
	 * Position is the one preference seen here: the duration scale, stack cap and severity floor
	 * apply at enqueue, so the queue arriving is the queue to draw. Swipe follows the position: a
	 * stack anchored left that could only be swiped right would be dragged across the app to
	 * dismiss.
	 */
	const position = useClientSettingsStore((s) => s.notifications.position);
	const { swipe, className } = toastPositionOption(position);

	return (
		<ToastProvider swipeDirection={swipe} label="Notification">
			{toasts.map(({ id, title, message, variant, action, duration, open }) => (
				<Toast
					key={id}
					variant={variant}
					duration={duration}
					// Controlled, so the toast sits closed while its exit animation runs:
					// `dismissToast` flips this and drops the entry TIMING.TOAST_EXIT_MS later;
					// removing it here would unmount the node before Radix animates it.
					open={open}
					// Fires for a timeout, the close button and a completed swipe, so dismissal has
					// one path.
					onOpenChange={(next) => {
						if (!next) dismissToast(id);
					}}
				>
					<ToastIcon variant={variant} />
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						{title ? <ToastTitle>{title}</ToastTitle> : null}
						<ToastDescription className={title ? "text-muted-foreground" : undefined}>
							{message}
						</ToastDescription>
						{action ? (
							<ToastAction
								// Radix requires it: what a screen reader is offered instead of a
								// button it cannot reach before the toast expires.
								altText={action.altText ?? action.label}
								onClick={action.onClick}
							>
								{action.label}
							</ToastAction>
						) : null}
					</div>
					<ToastClose aria-label="Dismiss notification" />
				</Toast>
			))}
			<ToastViewport className={className} />
		</ToastProvider>
	);
}

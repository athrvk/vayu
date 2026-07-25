/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toaster
 *
 * Renders the queue in `stores/toast-store.ts` through the Radix toast
 * primitive in `components/ui/toast.tsx`. Mounted once, in `App.tsx`.
 *
 * Accessibility - what changed, and what deliberately did not:
 *
 * The version this replaces was hand-rolled, and hand-rolled a live region:
 * one `role="status"` container that outlived every toast, because a region
 * that first appears together with its content is commonly not announced at
 * all. It also had to set `aria-atomic="false"` explicitly, since `role=
 * "status"` implies `true` and one shared region would otherwise re-announce
 * the entire stack on every arrival.
 *
 * Radix solves the same problem the other way round, and this was verified
 * against the rendered DOM rather than assumed: it gives *each* toast its own
 * visually-hidden `role="status" aria-live="polite"` region, mounts it **empty**,
 * and injects the text a frame later. The region still pre-exists its own
 * content, which is the property that mattered. And because each region holds
 * one toast rather than the whole stack, the implicit `aria-atomic="true"` is
 * now the correct value - so the explicit `false` is gone on purpose, not by
 * omission.
 *
 * What carried over untouched is the decision that everything is polite and
 * nothing is assertive - `type="background"` on the primitive. That argument is
 * unchanged by the swap and is recorded at `ui/toast.tsx`.
 *
 * `ToastProvider` also gives the viewport a hotkey - F8 by default - that moves
 * focus into the stack, and advertises it in the viewport's accessible name
 * ("Notifications (F8)", Radix's default, confirmed in the browser). The `label`
 * passed here is a different string: it prefixes the announced text, not the
 * region name, which comes from `ToastViewport`'s own `label`.
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
import { useToastStore } from "@/stores";

export default function Toaster() {
	const toasts = useToastStore((s) => s.toasts);
	const dismissToast = useToastStore((s) => s.dismissToast);

	return (
		<ToastProvider swipeDirection="right" label="Notification">
			{toasts.map(({ id, title, message, variant, action, duration, open }) => (
				<Toast
					key={id}
					variant={variant}
					duration={duration}
					// Controlled, so the toast can sit in the closed state while its
					// exit animation runs. `dismissToast` flips this to false and
					// drops the entry TOAST_EXIT_MS later; removing it here instead
					// would unmount the node before Radix could animate it.
					open={open}
					// Fires for a timeout, the close button and a completed swipe
					// alike, so dismissal has one path rather than three.
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
								// Radix requires this: it is what a screen reader is
								// offered in place of a button it cannot reach before
								// the toast expires.
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
			<ToastViewport />
		</ToastProvider>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/* global setTimeout */

/**
 * Toast Store
 *
 * The queue behind the toast UI. It holds *what* to show; the Radix Toast
 * primitive in `components/ui/toast.tsx` owns *when* - the dismiss timer,
 * pausing on hover, focus and window blur, swipe, and the open/closed state the
 * exit animation keys off.
 *
 * One timer is still ours, and it is not the dismiss timer: **a dismissed toast
 * is closed first and dropped `TOAST_EXIT_MS` later.** Deleting the entry inside
 * `onOpenChange(false)` unmounts the element in the same update that sets
 * `data-state="closed"`, and Radix cannot animate a node whose parent has
 * already removed it - the exit never gets a frame, and only the enter animation
 * ships. Holding the entry for the length of the animation is what gives the
 * primitive something to animate.
 *
 * This store used to carry that timer, and a note that the toast was "kept
 * in-house (rather than a toast library) so toasts render through the app's
 * design tokens". The token concern was right and still holds - it just never
 * required hand-rolling. A shadcn primitive is source in this repo wearing our
 * own token classes, exactly like `dialog.tsx` and `popover.tsx`; read
 * literally, the old note would have ruled those out too. What it actually
 * ruled out was a library that ships its own stylesheet, which is still the
 * reason `sonner` was not adopted.
 *
 * What is left is the two policies the primitive has no opinion about: dedup
 * and a cap.
 */

import { create } from "zustand";

export type ToastVariant = "info" | "success" | "warning" | "error";

/**
 * Per variant, not one constant.
 *
 * A confirmation is read at a glance; a failure has to be read, and often names
 * a cause from the engine ("database is locked") that takes longer to take in.
 * The primitive pauses all of these on hover, focus and window blur, so these
 * are floors rather than hard limits.
 */
export const TOAST_DURATION_MS: Record<ToastVariant, number> = {
	info: 4000,
	success: 4000,
	warning: 6000,
	error: 10000,
};

/**
 * Four is what fits above the fold at this width without the oldest sliding off
 * the top of the screen. Past that the oldest is dropped: a burst of failures
 * used to stack unbounded, and the ones that ran off-screen were unreachable
 * and undismissable.
 */
export const MAX_TOASTS = 4;

/**
 * How long a closed toast is kept before it is dropped from the queue. Must stay
 * in step with the exit animation on `ui/toast.tsx` (`duration-200`); shorter and
 * the node vanishes mid-animation, longer and a dismissed toast lingers doing
 * nothing. Under `prefers-reduced-motion` the animation collapses to ~0 and this
 * is simply an unnoticed 200ms in the queue.
 */
export const TOAST_EXIT_MS = 200;

export interface ToastAction {
	label: string;
	/** Spoken instead of the label where the label alone is not self-explanatory. */
	altText?: string;
	onClick: () => void;
}

export interface Toast {
	id: string;
	/** Optional headline above the message. Most callers pass a message only. */
	title?: string;
	message: string;
	variant: ToastVariant;
	action?: ToastAction;
	/** Handed to the primitive; see TOAST_DURATION_MS. */
	duration: number;
	/** False once dismissed, while the exit animation plays. See TOAST_EXIT_MS. */
	open: boolean;
}

export interface ToastOptions {
	title?: string;
	message: string;
	variant?: ToastVariant;
	action?: ToastAction;
	duration?: number;
}

interface ToastState {
	toasts: Toast[];
	/** Returns the toast id, so a caller can dismiss it before it expires. */
	showToast: (input: string | ToastOptions, variant?: ToastVariant) => string;
	/** Closes the toast; it leaves the queue TOAST_EXIT_MS later. */
	dismissToast: (id: string) => void;
	dismissAll: () => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
	toasts: [],

	showToast: (input, variant) => {
		const opts: ToastOptions =
			typeof input === "string" ? { message: input, variant: variant ?? "info" } : input;

		const resolved: Toast = {
			id: crypto.randomUUID(),
			...(opts.title ? { title: opts.title } : {}),
			message: opts.message,
			variant: opts.variant ?? "info",
			...(opts.action ? { action: opts.action } : {}),
			duration: opts.duration ?? TOAST_DURATION_MS[opts.variant ?? "info"],
			open: true,
		};

		/*
		 * Dedup, not stack. Several producers here fire the same string
		 * repeatedly - the OAuth2 load-test guard retries, and an SSE stream can
		 * fail every reconnect - and four identical copies of one sentence say
		 * nothing the first did not. Dropping the old entry and appending the new
		 * one restarts the primitive's timer, so a recurring failure stays on
		 * screen rather than expiring mid-retry.
		 */
		const withoutDuplicate = get().toasts.filter(
			(t) => !(t.message === resolved.message && t.variant === resolved.variant)
		);

		set({ toasts: [...withoutDuplicate, resolved].slice(-MAX_TOASTS) });
		return resolved.id;
	},

	dismissToast: (id) => {
		const target = get().toasts.find((t) => t.id === id);
		if (!target || !target.open) return; // already closing; do not re-arm

		set((s) => ({
			toasts: s.toasts.map((t) => (t.id === id ? { ...t, open: false } : t)),
		}));
		setTimeout(() => {
			set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
		}, TOAST_EXIT_MS);
	},

	dismissAll: () => {
		for (const t of get().toasts) get().dismissToast(t.id);
	},
}));

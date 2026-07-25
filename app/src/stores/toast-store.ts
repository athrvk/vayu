/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toast Store
 *
 * The queue behind the toast UI. It holds *what* to show; the Radix Toast
 * primitive in `components/ui/toast.tsx` owns *when* - the dismiss timer,
 * pausing on hover, focus and window blur, swipe, and the open/closed state the
 * exit animation keys off. So there is no `setTimeout` here any more.
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

	dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

	dismissAll: () => set({ toasts: [] }),
}));

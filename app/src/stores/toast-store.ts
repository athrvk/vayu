/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/* global setTimeout */

/**
 * The queue behind the toast UI. It holds what to show; the Radix Toast primitive in
 * `components/ui/toast.tsx` owns when: the dismiss timer, pausing on hover, focus and window blur,
 * swipe, and the open/closed state the exit animation keys off.
 *
 * One timer is still ours, and it is not the dismiss timer: **a dismissed toast is closed first and
 * dropped `TIMING.TOAST_EXIT_MS` later.** Deleting the entry inside `onOpenChange(false)` would
 * unmount the element in the same update that sets `data-state="closed"`, and Radix cannot animate
 * a node whose parent already removed it: the exit would never get a frame. Holding the entry for
 * the length of the animation gives the primitive something to animate.
 *
 * Toasts render through the app's design tokens, and a shadcn primitive keeps that: it is source in
 * this repo wearing our own token classes, like `dialog.tsx` and `popover.tsx`. A library that
 * ships its own stylesheet does not, which is why `sonner` was not adopted.
 *
 * What is left here is the policies the primitive has no opinion about: dedup, a cap, a severity
 * floor and a duration scale. The values are elsewhere (the delays in `config/timing.ts`,
 * everything user-configurable in `constants/toast.ts`, read off the client-settings store at
 * enqueue), so this file holds behaviour, not configuration.
 */

import { create } from "zustand";

import { TIMING } from "@/config/timing";
import { passesSeverityFloor, scaledDuration } from "@/constants/toast";
import { useClientSettingsStore } from "./client-settings-store";

export type ToastVariant = "info" | "success" | "warning" | "error";

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
	/** Handed to the primitive; see TIMING.TOAST_DURATION_MS. */
	duration: number;
	/** False once dismissed, while the exit animation plays. See TIMING.TOAST_EXIT_MS. */
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
	/** Closes the toast; it leaves the queue TIMING.TOAST_EXIT_MS later. */
	dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
	toasts: [],

	showToast: (input, variant) => {
		const opts: ToastOptions =
			typeof input === "string" ? { message: input, variant: variant ?? "info" } : input;

		// Named apart from the `variant` parameter above, which is only the
		// shorthand overload's second argument and is already folded into `opts`.
		const resolvedVariant = opts.variant ?? "info";

		/*
		 * Read, not subscribed: `showToast` is called from services, query callbacks and event
		 * handlers as often as from components, so there is no hook to hang a subscription on, and
		 * the preference only has to be right at the moment the toast is created.
		 */
		const prefs = useClientSettingsStore.getState().notifications;

		/*
		 * Below the floor: never queued, but still handed back an id. Callers keep the id to
		 * dismiss a toast early, which has to stay a safe no-op rather than a guard at every call
		 * site: muting a notification should not become a crash where it was raised.
		 */
		if (!passesSeverityFloor(resolvedVariant, prefs.minSeverity)) return crypto.randomUUID();

		const resolved: Toast = {
			id: crypto.randomUUID(),
			...(opts.title ? { title: opts.title } : {}),
			message: opts.message,
			variant: resolvedVariant,
			...(opts.action ? { action: opts.action } : {}),
			/*
			 * An explicit duration wins: a caller that names one means it. Otherwise the scale
			 * multiplies the variant's tuned value rather than replacing it, so an error still
			 * outlasts a confirmation at every setting.
			 */
			duration:
				opts.duration ??
				scaledDuration(TIMING.TOAST_DURATION_MS[resolvedVariant], prefs.durationScale),
			open: true,
		};

		/*
		 * Dedup, not stack. Several producers fire the same string repeatedly (the OAuth2 load-test
		 * guard retries, an SSE stream can fail every reconnect), and four identical copies of one
		 * sentence say nothing the first did not. Dropping the old entry and appending the new one
		 * restarts the primitive's timer, so a recurring failure stays on screen rather than
		 * expiring mid-retry.
		 */
		const withoutDuplicate = get().toasts.filter(
			(t) => !(t.message === resolved.message && t.variant === resolved.variant)
		);

		set({ toasts: [...withoutDuplicate, resolved].slice(-prefs.maxVisible) });
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
		}, TIMING.TOAST_EXIT_MS);
	},
}));

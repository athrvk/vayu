/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toast Store
 *
 * Lightweight transient-notification queue. Kept in-house (rather than a toast
 * library) so toasts render through the app's design tokens. Toasts auto-dismiss
 * after TOAST_TIMEOUT_MS; callers can also dismiss early.
 */

import { create } from "zustand";

const TOAST_TIMEOUT_MS = 4000;

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
	id: string;
	message: string;
	variant: ToastVariant;
}

interface ToastState {
	toasts: Toast[];
	showToast: (message: string, variant?: ToastVariant) => void;
	dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
	toasts: [],

	showToast: (message, variant = "info") => {
		const id = crypto.randomUUID();
		set((s) => ({ toasts: [...s.toasts, { id, message, variant }] }));
		setTimeout(() => {
			set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
		}, TOAST_TIMEOUT_MS);
	},

	dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

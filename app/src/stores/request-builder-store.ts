// Request Builder State Store

import { create } from "zustand";
import type { Request, SanityResult } from "@/types";

type RequestBuilderTab =
	| "params"
	| "headers"
	| "body"
	| "pre-script"
	| "test-script";

interface RequestBuilderState {
	currentRequest: Partial<Request> | null;
	isLoading: boolean;
	isSaving: boolean;
	hasUnsavedChanges: boolean;
	responseData: SanityResult | null;
	isExecuting: boolean;
	activeTab: RequestBuilderTab;

	// Actions
	setCurrentRequest: (request: Partial<Request> | null) => void;
	updateRequestField: <K extends keyof Request>(
		field: K,
		value: Request[K]
	) => void;
	setLoading: (loading: boolean) => void;
	setSaving: (saving: boolean) => void;
	setUnsavedChanges: (hasChanges: boolean) => void;
	setResponseData: (response: SanityResult | null) => void;
	setExecuting: (executing: boolean) => void;
	setActiveTab: (tab: RequestBuilderTab) => void;
	reset: () => void;

	// Helpers
	getHeadersArray: () => Array<{ key: string; value: string }>;
	setHeadersArray: (headers: Array<{ key: string; value: string }>) => void;
}

export const useRequestBuilderStore = create<RequestBuilderState>(
	(set, get) => ({
		currentRequest: null,
		isLoading: false,
		isSaving: false,
		hasUnsavedChanges: false,
		responseData: null,
		isExecuting: false,
		activeTab: "params",

		setCurrentRequest: (request) =>
			set({
				currentRequest: request,
				hasUnsavedChanges: false,
				responseData: null,
			}),

		updateRequestField: (field, value) =>
			set((state) => ({
				currentRequest: state.currentRequest
					? { ...state.currentRequest, [field]: value }
					: null,
				hasUnsavedChanges: true,
			})),

		setLoading: (loading) => set({ isLoading: loading }),
		setSaving: (saving) => set({ isSaving: saving }),
		setUnsavedChanges: (hasChanges) => set({ hasUnsavedChanges: hasChanges }),
		setResponseData: (response) => set({ responseData: response }),
		setExecuting: (executing) => set({ isExecuting: executing }),
		setActiveTab: (tab) => set({ activeTab: tab }),

		reset: () =>
			set({
				currentRequest: null,
				isLoading: false,
				isSaving: false,
				hasUnsavedChanges: false,
				responseData: null,
				isExecuting: false,
				activeTab: "params",
			}),

		// Helpers
		getHeadersArray: () => {
			const { currentRequest } = get();
			if (!currentRequest?.headers) return [];
			return Object.entries(currentRequest.headers).map(([key, value]) => ({
				key,
				value,
			}));
		},

		setHeadersArray: (headers) => {
			const headersObj: Record<string, string> = {};
			headers.forEach(({ key, value }) => {
				if (key.trim()) {
					headersObj[key] = value;
				}
			});
			set((state) => ({
				currentRequest: state.currentRequest
					? { ...state.currentRequest, headers: headersObj }
					: null,
				hasUnsavedChanges: true,
			}));
		},
	})
);

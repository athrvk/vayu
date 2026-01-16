/**
 * Response Store
 *
 * Persists response state per request ID so it survives:
 * - View switches (e.g., request builder <-> load test dashboard)
 * - Tab changes within the app
 *
 * Response data is stored in memory (not persisted to localStorage)
 * since responses can be large and we can reload from backend.
 */

import { create } from "zustand";

export interface StoredResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders?: Record<string, string>;
	rawRequest?: string;
	body: string;
	bodyType: "json" | "html" | "xml" | "text" | "binary";
	size: number;
	time: number;
	timestamp?: string;
	// Script execution results
	consoleLogs?: string[];
	testResults?: Array<{ name: string; passed: boolean; error?: string }>;
	preScriptError?: string;
	postScriptError?: string;
	// Metadata
	runId?: string;
	executedAt?: number;
}

interface ResponseStoreState {
	// Map of requestId -> response
	responses: Map<string, StoredResponse>;

	// Actions
	setResponse: (requestId: string, response: StoredResponse) => void;
	getResponse: (requestId: string) => StoredResponse | null;
	clearResponse: (requestId: string) => void;
	clearAll: () => void;
}

export const useResponseStore = create<ResponseStoreState>((set, get) => ({
	responses: new Map(),

	setResponse: (requestId, response) => {
		const newResponses = new Map(get().responses);
		newResponses.set(requestId, {
			...response,
			executedAt: response.executedAt || Date.now(),
		});
		set({ responses: newResponses });
	},

	getResponse: (requestId) => {
		return get().responses.get(requestId) || null;
	},

	clearResponse: (requestId) => {
		const newResponses = new Map(get().responses);
		newResponses.delete(requestId);
		set({ responses: newResponses });
	},

	clearAll: () => {
		set({ responses: new Map() });
	},
}));

/**
 * Script Completions Store
 * Caches script engine completions fetched from backend on startup.
 * Used by Monaco editor for autocomplete.
 */

import { create } from "zustand";
import type { ScriptCompletion, ScriptCompletionsResponse } from "@/types";
import { apiService } from "@/services/api";

interface ScriptCompletionsState {
    // Data
    completions: ScriptCompletion[];
    version: string | null;
    engine: string | null;

    // Status
    isLoading: boolean;
    isLoaded: boolean;
    error: string | null;

    // Actions
    fetchCompletions: () => Promise<void>;
    reset: () => void;
}

export const useScriptCompletionsStore = create<ScriptCompletionsState>((set, get) => ({
    // Initial state
    completions: [],
    version: null,
    engine: null,
    isLoading: false,
    isLoaded: false,
    error: null,

    fetchCompletions: async () => {
        // Skip if already loaded or loading
        if (get().isLoaded || get().isLoading) {
            return;
        }

        set({ isLoading: true, error: null });

        try {
            const response: ScriptCompletionsResponse = await apiService.getScriptCompletions();
            set({
                completions: response.completions,
                version: response.version,
                engine: response.engine,
                isLoading: false,
                isLoaded: true,
                error: null,
            });
        } catch (err) {
            console.error("Failed to fetch script completions:", err);
            set({
                isLoading: false,
                error: err instanceof Error ? err.message : "Failed to fetch completions",
            });
        }
    },

    reset: () => {
        set({
            completions: [],
            version: null,
            engine: null,
            isLoading: false,
            isLoaded: false,
            error: null,
        });
    },
}));

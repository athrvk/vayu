/**
 * Centralized Save Store
 * 
 * Manages auto-save functionality across the app with:
 * - Debounced auto-save on changes
 * - Manual save (Ctrl/Cmd+S)
 * - Visual save status for UI feedback
 * - Save context registry for app-wide save handling
 */

import { create } from "zustand";

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

/** Save context - represents a saveable entity in the app */
export interface SaveContext {
    /** Unique identifier for this save context */
    id: string;
    /** Human-readable name for the context (e.g., "Request", "Global Variables") */
    name: string;
    /** Function to perform the save */
    save: () => Promise<void>;
    /** Whether there are pending changes */
    hasPendingChanges: boolean;
}

interface SaveState {
    // Save status
    status: SaveStatus;
    lastSavedAt: number | null;
    errorMessage: string | null;
    
    // Pending save tracking
    pendingSaveId: string | null;
    
    // Active save context - the context that's currently focused/active
    activeContextId: string | null;
    
    // Registry of save contexts
    contexts: Map<string, SaveContext>;
    
    // Actions
    setStatus: (status: SaveStatus) => void;
    markPendingSave: (id: string) => void;
    startSaving: () => void;
    completeSave: () => void;
    failSave: (error: string) => void;
    clearError: () => void;
    reset: () => void;
    
    // Context management
    registerContext: (context: SaveContext) => void;
    unregisterContext: (id: string) => void;
    updateContext: (id: string, updates: Partial<Omit<SaveContext, 'id'>>) => void;
    setActiveContext: (id: string | null) => void;
    getActiveContext: () => SaveContext | null;
    
    // App-wide save trigger
    triggerSave: () => Promise<void>;
}

export const useSaveStore = create<SaveState>((set, get) => ({
    status: "idle",
    lastSavedAt: null,
    errorMessage: null,
    pendingSaveId: null,
    activeContextId: null,
    contexts: new Map(),

    setStatus: (status) => set({ status }),
    
    markPendingSave: (id) => set({ 
        status: "pending",
        pendingSaveId: id,
        errorMessage: null,
    }),
    
    startSaving: () => set({ 
        status: "saving",
        errorMessage: null,
    }),
    
    completeSave: () => set({ 
        status: "saved",
        lastSavedAt: Date.now(),
        pendingSaveId: null,
        errorMessage: null,
    }),
    
    failSave: (error) => set({ 
        status: "error",
        errorMessage: error,
        pendingSaveId: null,
    }),
    
    clearError: () => set({ 
        status: "idle",
        errorMessage: null,
    }),
    
    reset: () => set({
        status: "idle",
        lastSavedAt: null,
        errorMessage: null,
        pendingSaveId: null,
    }),
    
    // Context management
    registerContext: (context) => {
        const newContexts = new Map(get().contexts);
        newContexts.set(context.id, context);
        set({ contexts: newContexts });
    },
    
    unregisterContext: (id) => {
        const newContexts = new Map(get().contexts);
        newContexts.delete(id);
        const activeContextId = get().activeContextId === id ? null : get().activeContextId;
        set({ contexts: newContexts, activeContextId });
    },
    
    updateContext: (id, updates) => {
        const contexts = get().contexts;
        const existing = contexts.get(id);
        if (existing) {
            const newContexts = new Map(contexts);
            newContexts.set(id, { ...existing, ...updates });
            set({ contexts: newContexts });
        }
    },
    
    setActiveContext: (id) => set({ activeContextId: id }),
    
    getActiveContext: () => {
        const { activeContextId, contexts } = get();
        if (!activeContextId) return null;
        return contexts.get(activeContextId) || null;
    },
    
    // App-wide save trigger (used by Ctrl/Cmd+S)
    triggerSave: async () => {
        const activeContext = get().getActiveContext();
        if (!activeContext) {
            // If no active context, try to save any context with pending changes
            const contexts = get().contexts;
            for (const context of contexts.values()) {
                if (context.hasPendingChanges) {
                    try {
                        get().startSaving();
                        await context.save();
                        get().completeSave();
                        // Reset to idle after showing "saved"
                        setTimeout(() => {
                            get().setStatus("idle");
                        }, 2000);
                    } catch (error) {
                        get().failSave(error instanceof Error ? error.message : "Save failed");
                    }
                    return;
                }
            }
            return;
        }
        
        try {
            get().startSaving();
            await activeContext.save();
            get().completeSave();
            // Reset to idle after showing "saved"
            setTimeout(() => {
                get().setStatus("idle");
            }, 2000);
        } catch (error) {
            get().failSave(error instanceof Error ? error.message : "Save failed");
        }
    },
}));

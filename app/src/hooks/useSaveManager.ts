
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useSaveManager Hook
 *
 * Centralized auto-save manager that:
 * - Handles debounced auto-save for any saveable entity
 * - Registers with centralized save store for app-wide Ctrl/Cmd+S
 * - Updates centralized save status for UI feedback
 * - Manages save queue and prevents duplicate saves
 */

import { useEffect, useRef, useCallback } from "react";
import { useSaveStore } from "@/stores/save-store";

const AUTO_SAVE_DELAY_MS = 800; // 800ms debounce
const SAVED_STATUS_DURATION_MS = 2000; // Show "saved" for 2 seconds

interface UseSaveManagerOptions {
	/** Unique identifier for this save context (e.g., request ID) */
	entityId: string | null;
	/** Human-readable name for the context (e.g., "Request: GET /api/users") */
	contextName?: string;
	/** Function to perform the actual save */
	onSave: () => Promise<void>;
	/** Whether there are unsaved changes */
	hasChanges: boolean;
	/** Whether auto-save is enabled (default: true) */
	enabled?: boolean;
}

interface UseSaveManagerReturn {
	/** Trigger an immediate save */
	forceSave: () => Promise<void>;
	/** Current save status */
	status: "idle" | "pending" | "saving" | "saved" | "error";
	/** Whether currently saving */
	isSaving: boolean;
	/** Error message if save failed */
	errorMessage: string | null;
}

export function useSaveManager({
	entityId,
	contextName,
	onSave,
	hasChanges,
	enabled = true,
}: UseSaveManagerOptions): UseSaveManagerReturn {
	const {
		status,
		errorMessage,
		markPendingSave,
		startSaving,
		completeSave,
		failSave,
		setStatus,
		reset,
		registerContext,
		unregisterContext,
		updateContext,
		setActiveContext,
	} = useSaveStore();

	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const savedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const saveInProgressRef = useRef(false);
	const onSaveRef = useRef(onSave);

	// Keep onSave ref updated to avoid stale closures
	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	// Clear timeouts on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
			if (savedTimeoutRef.current) {
				clearTimeout(savedTimeoutRef.current);
			}
		};
	}, []);

	// Perform the actual save
	const performSave = useCallback(async () => {
		if (saveInProgressRef.current || !entityId) return;

		saveInProgressRef.current = true;
		startSaving();

		try {
			await onSaveRef.current();
			completeSave();

			// Reset to idle after showing "saved" status
			if (savedTimeoutRef.current) {
				clearTimeout(savedTimeoutRef.current);
			}
			savedTimeoutRef.current = setTimeout(() => {
				setStatus("idle");
			}, SAVED_STATUS_DURATION_MS);
		} catch (error) {
			console.error("Save failed:", error);
			failSave(error instanceof Error ? error.message : "Save failed");
		} finally {
			saveInProgressRef.current = false;
		}
	}, [entityId, startSaving, completeSave, failSave, setStatus]);

	// Register/unregister with centralized save context
	useEffect(() => {
		if (!entityId || !enabled) return;

		const contextId = `request-${entityId}`;

		registerContext({
			id: contextId,
			name: contextName || `Request`,
			save: performSave,
			hasPendingChanges: hasChanges,
		});
		setActiveContext(contextId);

		return () => {
			unregisterContext(contextId);
		};
	}, [
		entityId,
		enabled,
		contextName,
		performSave,
		hasChanges,
		registerContext,
		unregisterContext,
		setActiveContext,
	]);

	// Update context when hasChanges changes
	useEffect(() => {
		if (!entityId || !enabled) return;
		const contextId = `request-${entityId}`;
		updateContext(contextId, { hasPendingChanges: hasChanges, save: performSave });
	}, [entityId, enabled, hasChanges, performSave, updateContext]);

	// Reset on entity change
	useEffect(() => {
		reset();
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
	}, [entityId, reset]);

	// Force save (for manual triggers)
	const forceSave = useCallback(async () => {
		// Cancel any pending auto-save
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}

		await performSave();
	}, [performSave]);

	// Auto-save on changes (debounced)
	useEffect(() => {
		if (!enabled || !hasChanges || !entityId) {
			return;
		}

		// Mark as pending
		markPendingSave(entityId);

		// Clear existing timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Set new timeout for auto-save
		timeoutRef.current = setTimeout(() => {
			performSave();
		}, AUTO_SAVE_DELAY_MS);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [enabled, hasChanges, entityId, markPendingSave, performSave]);

	return {
		forceSave,
		status,
		isSaving: status === "saving",
		errorMessage,
	};
}

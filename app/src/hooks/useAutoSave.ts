// useAutoSave Hook - Auto-save request changes after debounce

import { useEffect, useRef, useCallback } from "react";
import { useRequestBuilderStore } from "@/stores";
import { useUpdateRequestMutation } from "@/queries";
import type { UpdateRequestRequest } from "@/types";

const AUTO_SAVE_DELAY_MS = 5000;

export function useAutoSave(enabled: boolean = true): void {
	const { currentRequest, hasUnsavedChanges, setSaving, setUnsavedChanges } =
		useRequestBuilderStore();
	const updateRequestMutation = useUpdateRequestMutation();
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const lastSavedRef = useRef<string>("");

	const saveRequest = useCallback(async () => {
		if (!currentRequest?.id) return;

		const requestJson = JSON.stringify(currentRequest);

		// Don't save if nothing changed since last save
		if (requestJson === lastSavedRef.current) {
			setUnsavedChanges(false);
			return;
		}

		setSaving(true);

		try {
			const updateData: UpdateRequestRequest = {
				id: currentRequest.id,
				name: currentRequest.name,
				description: currentRequest.description,
				method: currentRequest.method,
				url: currentRequest.url,
				headers: currentRequest.headers,
				body: currentRequest.body,
				body_type: currentRequest.body_type,
				auth: currentRequest.auth,
				pre_request_script: currentRequest.pre_request_script,
				test_script: currentRequest.test_script,
			};

			const updated = await updateRequestMutation.mutateAsync(updateData);
			lastSavedRef.current = JSON.stringify(updated);
			setUnsavedChanges(false);
		} catch (error) {
			console.error("Auto-save failed:", error);
			// Don't show error to user for auto-save failures
		} finally {
			setSaving(false);
		}
	}, [currentRequest, setSaving, setUnsavedChanges, updateRequestMutation]);

	useEffect(() => {
		if (!enabled || !hasUnsavedChanges || !currentRequest?.id) {
			return;
		}

		// Clear existing timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// Set new timeout
		timeoutRef.current = setTimeout(() => {
			saveRequest();
		}, AUTO_SAVE_DELAY_MS);

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [enabled, hasUnsavedChanges, currentRequest, saveRequest]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);
}

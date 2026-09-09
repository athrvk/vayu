/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "New request" - the whole flow, once.
 *
 * It lived inside `WelcomeScreen`, which was fine while the Launcher tile was
 * the only way to ask for one. The command palette is the second, and a second
 * copy of "decide where it lands, create a collection if there is none, ask when
 * it is ambiguous" is how two entry points end up disagreeing about where a
 * request goes.
 *
 * A hook rather than a store because the flow can *ask*: the picker is a dialog,
 * and a dialog needs a component to render it. Each caller renders its own from
 * `pickerProps`, so two surfaces never fight over one dialog's open state.
 */

import { useCallback, useState } from "react";
import {
	useCollectionsQuery,
	useCreateCollectionMutation,
	useCreateRequestMutation,
} from "@/queries";
import { useSessionStore, useTabsStore, useToastStore } from "@/stores";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME } from "@/constants/collection";
import { resolveNewRequestTarget } from "@/modules/welcome/targetCollection";
import type { Collection } from "@/types";

const CREATE_FAILED = "Could not create the request. Check that the engine is running.";

/** Everything `CollectionPicker` needs, so a caller spreads it and nothing else. */
export interface NewRequestPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	collections: Collection[];
	onSelect: (collectionId: string) => void;
}

export interface UseNewRequestReturn {
	/** Start the flow. Opens the picker only when the target is ambiguous. */
	newRequest: () => void;
	pickerProps: NewRequestPickerProps;
}

export function useNewRequest(): UseNewRequestReturn {
	const openTab = useTabsStore((s) => s.openTab);
	const showToast = useToastStore((s) => s.showToast);
	const lastCollectionId = useSessionStore((s) => s.lastCollectionId);
	const { data: collections = [] } = useCollectionsQuery();
	const createRequestMutation = useCreateRequestMutation();
	const createCollectionMutation = useCreateCollectionMutation();
	const [pickerOpen, setPickerOpen] = useState(false);

	const createRequestIn = useCallback(
		async (collectionId: string) => {
			try {
				const newRequest = await createRequestMutation.mutateAsync({
					collectionId,
					name: DEFAULT_REQUEST_NAME,
					method: "GET",
					url: "",
				});
				openTab({ type: "request", entityId: newRequest.id });
			} catch (error) {
				// Without this the click looks dead - the old code only logged.
				console.error("Failed to create new request:", error);
				showToast(CREATE_FAILED, "error");
			}
		},
		[createRequestMutation, openTab, showToast]
	);

	const newRequest = useCallback(() => {
		const target = resolveNewRequestTarget(lastCollectionId, collections);
		if (target.kind === "pick") {
			setPickerOpen(true);
			return;
		}
		if (target.kind === "collection") {
			void createRequestIn(target.collectionId);
			return;
		}
		// No collections yet - requests must belong to one, so make it first.
		void (async () => {
			try {
				const newCollection = await createCollectionMutation.mutateAsync({
					name: DEFAULT_COLLECTION_NAME,
				});
				await createRequestIn(newCollection.id);
			} catch (error) {
				console.error("Failed to create collection:", error);
				showToast(CREATE_FAILED, "error");
			}
		})();
	}, [collections, createCollectionMutation, createRequestIn, lastCollectionId, showToast]);

	const onSelect = useCallback(
		(collectionId: string) => {
			setPickerOpen(false);
			void createRequestIn(collectionId);
		},
		[createRequestIn]
	);

	return {
		newRequest,
		pickerProps: { open: pickerOpen, onOpenChange: setPickerOpen, collections, onSelect },
	};
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * WelcomeScreen
 *
 * Vayu's new-tab surface: rendered for the "welcome" tab (opened by "+"), when
 * no tab is open at all, and for a request tab with no entity. It is not a
 * resume screen - tabs are persisted and restored, so returning users land back
 * on their own tabs. Its job is to start something new.
 *
 * Two states: FirstRunWelcome on a fresh workspace, Launcher once there is anything
 * to show. See app/src/modules/welcome/README.md for what belongs on this screen.
 */

import { useState } from "react";
import {
	useTabsStore,
	useImportModalStore,
	useToastStore,
	useLayoutStore,
	useSessionStore,
} from "@/stores";
import {
	useCollectionsQuery,
	useRunsQuery,
	useCreateRequestMutation,
	useCreateCollectionMutation,
} from "@/queries";
import { ErrorState } from "@/components/shared";
import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { DEFAULT_COLLECTION_NAME } from "@/constants/collection";
import { resolveNewRequestTarget } from "./targetCollection";
import { CollectionPicker } from "./components/CollectionPicker";
import { FirstRunWelcome } from "./FirstRunWelcome";
import { Launcher } from "./Launcher";
import { LauncherSkeleton } from "./LauncherSkeleton";

const CREATE_FAILED = "Could not create the request. Check that the engine is running.";

export default function WelcomeScreen() {
	const openImport = useImportModalStore((s) => s.open);
	const showToast = useToastStore((s) => s.showToast);
	const { openTab } = useTabsStore();
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);
	const lastCollectionId = useSessionStore((s) => s.lastCollectionId);
	const {
		data: collections = [],
		isLoading: collectionsLoading,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();
	const {
		data: runs = [],
		isLoading: runsLoading,
		isError: runsFailed,
		error: runsError,
		refetch: refetchRuns,
	} = useRunsQuery();
	const createRequestMutation = useCreateRequestMutation();
	const createCollectionMutation = useCreateCollectionMutation();

	const [pickerOpen, setPickerOpen] = useState(false);

	const createRequestIn = async (collectionId: string) => {
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
	};

	const handleNewRequest = async () => {
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
		try {
			const newCollection = await createCollectionMutation.mutateAsync({
				name: DEFAULT_COLLECTION_NAME,
			});
			await createRequestIn(newCollection.id);
		} catch (error) {
			console.error("Failed to create collection:", error);
			showToast(CREATE_FAILED, "error");
		}
	};

	const handlePick = (collectionId: string) => {
		setPickerOpen(false);
		void createRequestIn(collectionId);
	};

	// Both queries start as [] while loading, which would read as an empty
	// workspace and flash the first-run screen at returning users - hence the
	// skeleton rather than rendering either real state early.
	const isLoading = collectionsLoading || runsLoading;
	const isEmpty = collections.length === 0 && runs.length === 0;

	// A failed load is not a fresh workspace. Neither query sets `throwOnError`
	// and both are destructured with `= []`, so a failure used to land in
	// `isEmpty` and render the branded first-run pitch - telling a user with
	// collections and runs that they are brand new, and inviting them to import
	// collections they already have.
	//
	// Gated on `isEmpty` on purpose: TanStack keeps the last good data through a
	// failed background refetch, and swapping a working Launcher for an error
	// pane would take away more than it tells. If either query returned
	// anything, the Launcher still has something true to show.
	const hasFailed = collectionsFailed || runsFailed;
	// One message is enough; whichever failed first answers "why".
	const failure = collectionsError ?? runsError;
	const failureDetail = failure instanceof Error ? failure.message : undefined;
	// The user is retrying the screen, not one query.
	const retry = () => {
		void refetchCollections();
		void refetchRuns();
	};

	return (
		<div className="flex-1 overflow-auto bg-background">
			<div className="max-w-2xl px-8 py-10">
				{isLoading ? (
					<LauncherSkeleton />
				) : isEmpty ? (
					hasFailed ? (
						<ErrorState
							title="Couldn't load your workspace"
							detail={failureDetail}
							onRetry={retry}
						/>
					) : (
						<FirstRunWelcome onImport={openImport} onNewRequest={handleNewRequest} />
					)
				) : (
					<Launcher
						runs={runs}
						collectionCount={collections.length}
						onImport={openImport}
						onNewRequest={handleNewRequest}
						onHistory={() => activateDrawerView("history")}
						onVariables={() => openTab({ type: "variables", entityId: null })}
					/>
				)}
			</div>
			<CollectionPicker
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				collections={collections}
				onSelect={handlePick}
			/>
		</div>
	);
}

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

import { useTabsStore, useImportModalStore, useLayoutStore } from "@/stores";
import { useCollectionsQuery, useRunsQuery, flattenRunPages } from "@/queries";
import { ErrorState } from "@/components/shared";
import { useNewRequest } from "@/hooks/useNewRequest";
import { CollectionPicker } from "./components/CollectionPicker";
import { FirstRunWelcome } from "./FirstRunWelcome";
import { Launcher } from "./Launcher";
import { LauncherSkeleton } from "./LauncherSkeleton";

export default function WelcomeScreen() {
	const openImport = useImportModalStore((s) => s.open);
	const { openTab } = useTabsStore();
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);
	const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);
	// The flow itself lives in `useNewRequest`, shared with the command palette's
	// "New request" - this screen renders its picker, nothing more.
	const { newRequest, pickerProps } = useNewRequest();
	const {
		data: collections = [],
		isLoading: collectionsLoading,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();
	const {
		data: runsData,
		isLoading: runsLoading,
		isError: runsFailed,
		error: runsError,
		refetch: refetchRuns,
	} = useRunsQuery();
	// Flatten the loaded pages; the Launcher only shows the most recent handful.
	const runs = flattenRunPages(runsData);

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
						<FirstRunWelcome onImport={openImport} onNewRequest={newRequest} />
					)
				) : (
					<Launcher
						runs={runs}
						collectionCount={collections.length}
						onImport={openImport}
						onNewRequest={newRequest}
						onSearch={() => setPaletteOpen(true)}
						onHistory={() => activateDrawerView("history")}
						onVariables={() => openTab({ type: "variables", entityId: null })}
						onServices={() => activateDrawerView("services")}
					/>
				)}
			</div>
			<CollectionPicker {...pickerProps} />
		</div>
	);
}

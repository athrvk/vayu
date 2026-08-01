/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Queries Index
 *
 * Central export for all TanStack Query hooks.
 */

// Query Keys
export { queryKeys } from "./keys";

// Collections & Requests
export {
	useCollectionsQuery,
	usePrefetchCollectionsAndRequests,
	useRequestsQuery,
	useMultipleCollectionRequests,
	useRequestQuery,
	requestDetailOptions,
	useCollectionAncestors,
	useCreateCollectionMutation,
	useUpdateCollectionMutation,
	useDeleteCollectionMutation,
	useCreateRequestMutation,
	useUpdateRequestMutation,
	useDeleteRequestMutation,
	isRequestNotFound,
} from "./collections";
export { RequestNotFoundError } from "./collections";

// Runs (History)
export {
	useRunsQuery,
	useAllRunsQuery,
	flattenRunPages,
	runsTotal,
	useRunQuery,
	runDetailOptions,
	useRunReportQuery,
	useLastDesignRunQuery,
	useDeleteRunMutation,
	useInvalidateRuns,
	isRunNotFound,
} from "./runs";
export { RunNotFoundError } from "./runs";

// Environments
export {
	useEnvironmentsQuery,
	useCreateEnvironmentMutation,
	useUpdateEnvironmentMutation,
	useSetActiveEnvironmentMutation,
	useDeleteEnvironmentMutation,
} from "./environments";

// Global Variables
export { useGlobalsQuery, useUpdateGlobalsMutation } from "./globals";

// Health & Config
export { useHealthQuery } from "./health";
export { useConfigQuery, useUpdateConfigMutation } from "./config";

// Script Completions
export { useScriptCompletionsQuery } from "./script-completions";
export { useScriptTypeDefinitionsQuery } from "./script-types";

// OAuth 2.0
export {
	useOAuth2TokenStatusQuery,
	useFetchOAuth2TokenMutation,
	useClearOAuth2TokenMutation,
} from "./oauth";

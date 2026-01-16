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
	useCreateCollectionMutation,
	useUpdateCollectionMutation,
	useDeleteCollectionMutation,
	useCreateRequestMutation,
	useUpdateRequestMutation,
	useDeleteRequestMutation,
} from "./collections";

// Runs (History)
export {
	useRunsQuery,
	useRunReportQuery,
	useLastDesignRunQuery,
	useDeleteRunMutation,
	useAddRunToCache,
	useInvalidateRuns,
} from "./runs";

// Environments
export {
	useEnvironmentsQuery,
	useEnvironmentQuery,
	useCreateEnvironmentMutation,
	useUpdateEnvironmentMutation,
	useDeleteEnvironmentMutation,
} from "./environments";

// Global Variables
export { useGlobalsQuery, useUpdateGlobalsMutation } from "./globals";

// Health & Config
export { useHealthQuery, useConfigQuery } from "./health";

// Script Completions
export { useScriptCompletionsQuery } from "./script-completions";

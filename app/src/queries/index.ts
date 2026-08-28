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
	useReorderMutation,
	isRequestNotFound,
} from "./collections";
export { RequestNotFoundError } from "./collections";

// Saved example responses (issues #481, #588)
export {
	useRequestExamplesQuery,
	useCreateRequestExampleMutation,
	useDeleteRequestExampleMutation,
} from "./request-examples";

// Bound OpenAPI documents (issues #637, #638)
export {
	useSpecQuery,
	useSpecMetaQuery,
	useSpecContentReader,
	useBindSpecMutation,
	type BindSpecInput,
} from "./specs";

// Runs (History)
export {
	useRunsQuery,
	useRunSearchQuery,
	RUN_SEARCH_LIMIT,
	useAllRunsQuery,
	flattenRunPages,
	runsTotal,
	useRunQuery,
	runDetailOptions,
	useRunReportQuery,
	useLastDesignRunQuery,
	useRecentDesignRunsQuery,
	RECENT_DESIGN_RUN_LIMIT,
	useLastCollectionRunQuery,
	useBaselineRunQuery,
	useDeleteRunMutation,
	useSetRunBaselineMutation,
	useStartScenarioRunMutation,
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

// Cookie jar
export { useCookiesQuery, useClearCookiesMutation } from "./cookies";

// Client-certificate registry (issue #707)
export {
	useClientCertificatesQuery,
	useCreateClientCertificateMutation,
	useUpdateClientCertificateMutation,
	useDeleteClientCertificateMutation,
} from "./client-certificates";

// Webhook inbox
export {
	useInboxesQuery,
	useInboxCapturesQuery,
	useLoadMoreInboxCapturesMutation,
	useStartInboxMutation,
	useStopInboxMutation,
	useDeleteInboxMutation,
	useUpdateInboxResponseMutation,
	useClearInboxCapturesMutation,
	mergeCapture,
	mergeCaptures,
} from "./inbox";

// OAuth 2.0 mock issuer
export {
	useMockIssuersQuery,
	useStartMockIssuerMutation,
	useUpdateMockIssuerMutation,
	useStopMockIssuerMutation,
} from "./mock-issuer";

// Collection mock server (issue #481 phase 2)
export {
	useMockServersQuery,
	useMockServerRoutesQuery,
	useStartMockServerMutation,
	useStopMockServerMutation,
} from "./mock-server";

// Trash (issue #988)
export { useTrashQuery, useRestoreTrashMutation, usePurgeTrashMutation } from "./trash";

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

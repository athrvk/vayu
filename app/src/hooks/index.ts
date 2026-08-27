/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Remaining hooks (not replaced by TanStack Query)
export { useEngine } from "./useEngine";
export { useSaveManager } from "./useSaveManager";
export { useEntityDraft } from "./useEntityDraft";
export { useDraftSaveContext } from "./useDraftSaveContext";
export { useVariableResolver } from "./useVariableResolver";
export { useActiveEnvironmentGuard } from "./useActiveEnvironmentGuard";
export { useVariableCompletionProvider } from "./useVariableCompletionProvider";
export { useDataContract } from "./useDataContract";
export { useDeclaredDataFile, type DeclaredDataFileState } from "./useDeclaredDataFile";
export { useElectronTheme } from "./useElectronTheme";
export { useResizable } from "./useResizable";
export { useOverflowTitle } from "./useOverflowTitle";
export { usePrefersReducedMotion } from "./usePrefersReducedMotion";
export { useCopy } from "./useCopy";

// Note: useCollections, useRuns, useHealthCheck have been replaced by TanStack Query hooks
// Import from @/queries instead

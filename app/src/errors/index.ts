
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Errors Index
 *
 * Central export for error handling utilities.
 */

export { ErrorBoundary } from "./ErrorBoundary";
export {
	handleApiError,
	isRetryableError,
	getErrorSeverity,
	type UserFriendlyError,
	type ErrorSeverity,
} from "./error-handler";
export { logError, logApiError, type ErrorContext } from "./error-logger";

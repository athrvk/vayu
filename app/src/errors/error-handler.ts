
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Error Handler
 *
 * Utilities for handling and transforming errors into user-friendly messages.
 */

import { ApiError } from "@/services/http-client";
import { ErrorCode, ErrorMessages, ErrorHints } from "@/constants/error-codes";

/**
 * User-friendly error representation
 */
export interface UserFriendlyError {
	title: string;
	message: string;
	hint?: string;
	code?: string;
	statusCode?: number;
}

/**
 * Handle API errors and convert them to user-friendly format
 */
export function handleApiError(error: unknown): UserFriendlyError {
	// Handle ApiError instances
	if (error instanceof ApiError) {
		return {
			title: "Request Failed",
			message: error.userFriendlyMessage,
			hint: ErrorHints[error.errorCode as keyof typeof ErrorHints],
			code: error.errorCode,
			statusCode: error.statusCode,
		};
	}

	// Handle generic Error instances
	if (error instanceof Error) {
		// Check for common error patterns
		if (error.message.includes("timeout") || error.message.includes("timed out")) {
			return {
				title: "Request Timeout",
				message: ErrorMessages[ErrorCode.TIMEOUT],
				hint: ErrorHints[ErrorCode.TIMEOUT],
				code: ErrorCode.TIMEOUT,
			};
		}

		if (error.message.includes("network") || error.message.includes("fetch")) {
			return {
				title: "Network Error",
				message: ErrorMessages[ErrorCode.CONNECTION_FAILED],
				hint: ErrorHints[ErrorCode.CONNECTION_FAILED],
				code: ErrorCode.CONNECTION_FAILED,
			};
		}

		return {
			title: "Error",
			message: error.message || "An unexpected error occurred",
		};
	}

	// Handle unknown error types
	return {
		title: "Unknown Error",
		message: "An unexpected error occurred. Please try again.",
	};
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof ApiError) {
		// Network errors and timeouts are retryable
		return error.isNetworkError || error.isTimeout;
	}

	if (error instanceof Error) {
		// Network-related errors are retryable
		return (
			error.message.includes("network") ||
			error.message.includes("timeout") ||
			error.message.includes("fetch")
		);
	}

	return false;
}

/**
 * Get error severity level
 */
export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export function getErrorSeverity(error: unknown): ErrorSeverity {
	if (error instanceof ApiError) {
		if (error.isDatabaseError) {
			return "critical";
		}
		if (error.isNetworkError || error.isTimeout) {
			return "medium";
		}
		if (error.statusCode >= 500) {
			return "high";
		}
		return "low";
	}

	return "medium";
}

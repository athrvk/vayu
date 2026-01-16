/**
 * Error Logger
 *
 * Centralized error logging utility.
 */

import type { ErrorSeverity } from "./error-handler";

/**
 * Error context for logging
 */
export interface ErrorContext {
	component?: string;
	action?: string;
	userId?: string;
	requestId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Log error to console (and potentially to external service in the future)
 */
export function logError(
	error: Error,
	severity: ErrorSeverity = "medium",
	context?: ErrorContext
): void {
	const timestamp = new Date().toISOString();
	const logEntry = {
		timestamp,
		severity,
		error: {
			name: error.name,
			message: error.message,
			stack: error.stack,
		},
		context,
	};

	// Log to console with appropriate level
	switch (severity) {
		case "critical":
		case "high":
			console.error("[ERROR]", logEntry);
			break;
		case "medium":
			console.warn("[WARN]", logEntry);
			break;
		case "low":
			console.info("[INFO]", logEntry);
			break;
	}

	// TODO: In the future, send to external logging service
	// Example: sendToLoggingService(logEntry);
}

/**
 * Log API error with context
 */
export function logApiError(error: unknown, context?: ErrorContext): void {
	if (error instanceof Error) {
		const severity = error.name === "ApiError" ? "medium" : "high";
		logError(error, severity, context);
	} else {
		logError(new Error(String(error)), "medium", context);
	}
}

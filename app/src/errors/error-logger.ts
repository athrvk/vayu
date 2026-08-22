/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Error Logger
 *
 * Centralized error logging utility.
 */

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

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
 * Log an error to the console, at the level its severity earns.
 *
 * The console is the whole of it. Vayu runs on the user's machine and ships no
 * telemetry; sending errors anywhere else is a product decision nobody has
 * made, not a wiring gap to be filled in passing.
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
			// The bottom rung of a severity ladder, not debug chatter: this branch
			// exists so a low entry does not shout as a warning. Raising it to
			// `console.warn` to satisfy `no-console` would erase the distinction
			// the switch is here to make.
			// eslint-disable-next-line no-console
			console.info("[INFO]", logEntry);
			break;
	}
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

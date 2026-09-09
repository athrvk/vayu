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

/** The schema's closed `cat` enum for `src: "renderer"` (#1558). */
const RENDERER_CATEGORIES = new Set(["renderer", "boundary"]);

/** `context.component` when it is itself a valid category, else the generic one. */
function categoryFor(context?: ErrorContext): "renderer" | "boundary" {
	const component = context?.component;
	return component !== undefined && RENDERER_CATEGORIES.has(component)
		? (component as "renderer" | "boundary")
		: "renderer";
}

function levelFor(severity: ErrorSeverity): "debug" | "info" | "warn" | "error" {
	switch (severity) {
		case "critical":
		case "high":
			return "error";
		case "medium":
			return "warn";
		case "low":
			return "info";
	}
}

/**
 * Log an error, at the level its severity earns.
 *
 * Forwarded to the app's own log file through `electronAPI.log` (#1558) when
 * it is available - `main.ts` validates the shape, redacts and applies the
 * `logLevel` floor, so this side does neither. Outside Electron (`vite` in a
 * browser, the sweep/probe harnesses `app/CLAUDE.md` describes) there is no
 * main process to forward to, so this keeps today's console behaviour, which
 * is what those environments read.
 */
export function logError(
	error: Error,
	severity: ErrorSeverity = "medium",
	context?: ErrorContext
): void {
	if (window.electronAPI) {
		window.electronAPI.log({
			level: levelFor(severity),
			cat: categoryFor(context),
			msg: error.message || error.name,
			err: { name: error.name, message: error.message, stack: error.stack },
			fields: {
				severity,
				...(context?.component !== undefined ? { component: context.component } : {}),
				...(context?.action !== undefined ? { action: context.action } : {}),
				...(context?.userId !== undefined ? { userId: context.userId } : {}),
				...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
				...(context?.metadata !== undefined ? { metadata: context.metadata } : {}),
			},
		});
		return;
	}

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

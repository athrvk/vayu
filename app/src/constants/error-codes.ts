
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Error codes matching backend ErrorCode enum
 * Keep in sync with engine/include/vayu/types.hpp
 * 
 * Note: The engine sends errorCode and errorMessage directly in responses.
 * The UI should use errorMessage as-is without re-mapping.
 */

export const ErrorCode = {
	NONE: "NONE",
	TIMEOUT: "TIMEOUT",
	CONNECTION_FAILED: "CONNECTION_FAILED",
	DNS_ERROR: "DNS_ERROR",
	SSL_ERROR: "SSL_ERROR",
	INVALID_URL: "INVALID_URL",
	INVALID_METHOD: "INVALID_METHOD",
	SCRIPT_ERROR: "SCRIPT_ERROR",
	INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

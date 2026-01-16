/**
 * Error codes matching backend ErrorCode enum
 * Keep in sync with engine/include/vayu/types.hpp
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

	// Frontend-specific error codes (not in backend enum)
	DATABASE_ERROR: "DATABASE_ERROR",
	INVALID_JSON: "INVALID_JSON",
	INVALID_REQUEST: "INVALID_REQUEST",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * HTTP status codes for different error types
 */
export const ErrorStatusCodes = {
	TIMEOUT: 504,
	DNS_ERROR: 502,
	CONNECTION_FAILED: 503,
	BAD_GATEWAY: 502,
} as const;

/**
 * User-friendly error messages
 */
export const ErrorMessages = {
	[ErrorCode.TIMEOUT]: "Request timed out. The server took too long to respond.",
	[ErrorCode.DNS_ERROR]: "Could not resolve the domain name. Please check the URL.",
	[ErrorCode.CONNECTION_FAILED]:
		"Could not connect to the server. Please verify the URL and ensure the server is running.",
	[ErrorCode.SSL_ERROR]: "SSL/TLS connection error. Please check the certificate.",
	[ErrorCode.INVALID_URL]: "Invalid URL format. Please check the URL.",
	[ErrorCode.INVALID_METHOD]: "Invalid HTTP method.",
	[ErrorCode.SCRIPT_ERROR]: "Error executing script.",
	[ErrorCode.INTERNAL_ERROR]: "Internal server error occurred.",
	[ErrorCode.DATABASE_ERROR]: "Database error occurred while saving the request.",
	[ErrorCode.INVALID_JSON]: "Invalid request format. Please check your request body.",
	[ErrorCode.INVALID_REQUEST]: "Invalid request. Please check your input.",
} as const;

/**
 * Helpful hints for different error scenarios
 */
export const ErrorHints = {
	[ErrorCode.TIMEOUT]: "💡 Try increasing the request timeout in settings",
	[ErrorCode.DNS_ERROR]: "💡 Verify the domain name is correct and accessible",
	[ErrorCode.CONNECTION_FAILED]: "💡 Verify the URL and ensure the target server is running",
	[ErrorCode.SSL_ERROR]: "💡 Check if the server's SSL certificate is valid",
} as const;

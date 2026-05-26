
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * httpStatusText — canonical IANA reason phrase for an HTTP status code.
 *
 * Mapping verified against the IANA HTTP Status Code Registry:
 *   https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml
 *
 * Notable RFC 9110 renames vs. earlier specs:
 *   - 413: "Payload Too Large" → "Content Too Large"
 *   - 422: "Unprocessable Entity" → "Unprocessable Content"
 *
 * Codes that are registered but obsoleted/deprecated (305, 510) are kept so
 * the UI shows meaningful text if a server still emits them. Code 418 is
 * marked "(Unused)" in IANA — intentionally omitted; the 4xx bucket label
 * applies via the class-based fallback below.
 */

const STATUS_TEXT: Record<number, string> = {
	// 1xx Informational
	100: "Continue",
	101: "Switching Protocols",
	102: "Processing",
	103: "Early Hints",
	104: "Upload Resumption Supported",

	// 2xx Success
	200: "OK",
	201: "Created",
	202: "Accepted",
	203: "Non-Authoritative Information",
	204: "No Content",
	205: "Reset Content",
	206: "Partial Content",
	207: "Multi-Status",
	208: "Already Reported",
	226: "IM Used",

	// 3xx Redirection
	300: "Multiple Choices",
	301: "Moved Permanently",
	302: "Found",
	303: "See Other",
	304: "Not Modified",
	305: "Use Proxy",
	307: "Temporary Redirect",
	308: "Permanent Redirect",

	// 4xx Client Error
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	406: "Not Acceptable",
	407: "Proxy Authentication Required",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	411: "Length Required",
	412: "Precondition Failed",
	413: "Content Too Large",
	414: "URI Too Long",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	417: "Expectation Failed",
	421: "Misdirected Request",
	422: "Unprocessable Content",
	423: "Locked",
	424: "Failed Dependency",
	425: "Too Early",
	426: "Upgrade Required",
	428: "Precondition Required",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	451: "Unavailable For Legal Reasons",

	// 5xx Server Error
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
	505: "HTTP Version Not Supported",
	506: "Variant Also Negotiates",
	507: "Insufficient Storage",
	508: "Loop Detected",
	510: "Not Extended",
	511: "Network Authentication Required",
};

export function httpStatusText(status: number): string {
	if (status === 0) return "Error";
	const known = STATUS_TEXT[status];
	if (known) return known;
	// Unknown code — return the class label so the badge stays meaningful.
	if (status >= 100 && status < 200) return "Informational";
	if (status >= 200 && status < 300) return "Success";
	if (status >= 300 && status < 400) return "Redirect";
	if (status >= 400 && status < 500) return "Client Error";
	if (status >= 500 && status < 600) return "Server Error";
	return "Unknown";
}

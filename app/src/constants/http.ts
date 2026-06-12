/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { HttpMethod } from "@/types";

/** HTTP methods supported by the request builder, in display order. */
export const HTTP_METHODS: HttpMethod[] = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
];

/** Standard HTTP headers offered for autocomplete in the headers editor. */
export const STANDARD_HEADERS = [
	"Accept",
	"Accept-Charset",
	"Accept-Encoding",
	"Accept-Language",
	"Authorization",
	"Cache-Control",
	"Content-Disposition",
	"Content-Encoding",
	"Content-Language",
	"Content-Length",
	"Content-Type",
	"Cookie",
	"Date",
	"ETag",
	"Expires",
	"Host",
	"If-Match",
	"If-Modified-Since",
	"If-None-Match",
	"If-Unmodified-Since",
	"Origin",
	"Pragma",
	"Range",
	"Referer",
	"User-Agent",
	"X-Api-Key",
	"X-Correlation-Id",
	"X-Forwarded-For",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
	"X-Request-Id",
	"X-Requested-With",
];

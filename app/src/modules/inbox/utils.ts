/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { InboxCapture } from "@/types";

/**
 * The absolute URL a capture arrived at.
 *
 * The engine records the path and the raw query separately - that is what the
 * capture *is* - so the URL the viewer and the raw HTTP text need is rebuilt
 * here rather than stored twice.
 */
export function captureUrl(capture: InboxCapture, inboxUrl: string): string {
	const base = inboxUrl.endsWith("/") ? inboxUrl.slice(0, -1) : inboxUrl;
	return `${base}${capture.path}${capture.query ? `?${capture.query}` : ""}`;
}

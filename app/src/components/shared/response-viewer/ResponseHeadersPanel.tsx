/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Headers tab: request headers collapsed, response headers open.
 *
 * `ResponseHeadersTab` in the request builder and an inline block in
 * `UnifiedResponseViewer` were the same panel, reached through differently
 * shaped data - one read `response.requestHeaders`, the other a separate
 * `effectiveRequest`. The prop shape here is the normalised one: two header
 * maps, neither of which the caller has to nest inside a response object.
 *
 * The history copy also lacked the empty-state fallback. `HeadersViewer`
 * renders `null` when it has no entries, so a response with no headers showed a
 * blank pane there with nothing explaining why. That fallback is kept.
 */

import { EmptyState } from "../EmptyState";
import HeadersViewer from "./HeadersViewer";

export interface ResponseHeadersPanelProps {
	/** Headers that were sent. Collapsed by default - usually not the question. */
	requestHeaders?: Record<string, string>;
	/** Headers that came back. Open by default. */
	responseHeaders?: Record<string, string>;
}

export function ResponseHeadersPanel({
	requestHeaders,
	responseHeaders,
}: ResponseHeadersPanelProps) {
	const response = responseHeaders ?? {};
	const hasRequestHeaders = requestHeaders && Object.keys(requestHeaders).length > 0;

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{hasRequestHeaders && (
				<HeadersViewer headers={requestHeaders} variant="request" defaultOpen={false} />
			)}

			<HeadersViewer headers={response} variant="response" defaultOpen={true} />

			{Object.keys(response).length === 0 && (
				<EmptyState variant="inline" title="No headers in response" />
			)}
		</div>
	);
}

export default ResponseHeadersPanel;

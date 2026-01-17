
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseHeadersTab Component
 *
 * Displays both request and response headers using shared HeadersViewer component.
 */

import { HeadersViewer } from "@/components/shared/response-viewer";

export interface ResponseHeadersTabProps {
	response: {
		headers: Record<string, string>;
		requestHeaders?: Record<string, string>;
	};
}

export default function ResponseHeadersTab({ response }: ResponseHeadersTabProps) {
	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{/* Request Headers */}
			{response.requestHeaders && Object.keys(response.requestHeaders).length > 0 && (
				<HeadersViewer
					headers={response.requestHeaders}
					variant="request"
					defaultOpen={false}
				/>
			)}

			{/* Response Headers */}
			<HeadersViewer headers={response.headers} variant="response" defaultOpen={true} />

			{Object.keys(response.headers).length === 0 && (
				<div className="p-8 text-center text-muted-foreground">No headers in response</div>
			)}
		</div>
	);
}

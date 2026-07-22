/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RawRequestResponse Component
 *
 * Displays raw HTTP request and response (similar to Postman).
 */

import { CodeEditor } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { buildRawResponse } from "@/components/shared/response-viewer";

export interface RawRequestResponseProps {
	rawRequest: string;
	response: {
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
	};
}

export default function RawRequestResponse({ rawRequest, response }: RawRequestResponseProps) {
	// Use shared utility to build raw response
	const rawResponse = buildRawResponse(
		response.status,
		response.statusText,
		response.headers,
		response.body
	);

	// Combine request and response with a separator
	const combinedRaw = rawRequest
		? `${rawRequest}\n\n${"─".repeat(60)}\n\n${rawResponse}`
		: rawResponse;

	if (!rawRequest && !response) {
		return <EmptyState variant="inline" title="No raw data available" />;
	}

	return (
		<CodeEditor
			height="100%"
			language="http"
			value={combinedRaw}
			readOnly
			options={{ folding: false }}
		/>
	);
}

/**
 * RawRequestResponse Component
 *
 * Displays raw HTTP request and response (similar to Postman).
 */

import Editor from "@monaco-editor/react";
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
		return <div className="p-8 text-center text-muted-foreground">No raw data available</div>;
	}

	return (
		<Editor
			height="100%"
			language="http"
			value={combinedRaw}
			theme="vs-dark"
			options={{
				readOnly: true,
				minimap: { enabled: false },
				fontSize: 13,
				lineNumbers: "on",
				scrollBeyondLastLine: false,
				wordWrap: "on",
				automaticLayout: true,
				folding: false,
			}}
		/>
	);
}

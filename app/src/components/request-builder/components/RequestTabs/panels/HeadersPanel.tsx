/**
 * HeadersPanel Component
 * 
 * Request headers editor
 */

import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { KeyValueItem } from "../../../types";

// Standard HTTP headers for autocomplete
const STANDARD_HEADERS = [
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

export default function HeadersPanel() {
    const { request, updateField } = useRequestBuilderContext();

    const handleHeadersChange = (newHeaders: KeyValueItem[]) => {
        updateField("headers", newHeaders);
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Add headers to include with your request. Use <code className="bg-muted px-1 rounded">{"{{variable}}"}</code> for dynamic values.
            </p>

            <KeyValueEditor
                items={request.headers}
                onChange={handleHeadersChange}
                keyPlaceholder="Header"
                valuePlaceholder="Value"
                showResolved={true}
                allowDisable={true}
                keySuggestions={STANDARD_HEADERS}
            />
        </div>
    );
}

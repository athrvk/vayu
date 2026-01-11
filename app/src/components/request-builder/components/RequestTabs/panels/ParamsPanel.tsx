/**
 * ParamsPanel Component
 * 
 * Query parameters editor with URL sync
 */

import { useCallback, useMemo } from "react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { KeyValueItem } from "../../../types";

// Build URL from base and params
// Note: We don't URL-encode values containing {{variables}} - they get resolved and encoded at request time
function buildUrlWithParams(baseUrl: string, params: KeyValueItem[]): string {
    const queryStart = baseUrl.indexOf("?");
    const base = queryStart === -1 ? baseUrl : baseUrl.slice(0, queryStart);

    const enabledParams = params.filter((p) => p.enabled && p.key.trim());
    if (enabledParams.length === 0) return base;

    const queryString = enabledParams
        .map((p) => {
            // Don't encode if contains variable placeholder - will be resolved later
            const hasVarInKey = /\{\{[^{}]+\}\}/.test(p.key);
            const hasVarInValue = /\{\{[^{}]+\}\}/.test(p.value);
            const key = hasVarInKey ? p.key : encodeURIComponent(p.key);
            const value = hasVarInValue ? p.value : encodeURIComponent(p.value);
            return p.value ? `${key}=${value}` : key;
        })
        .join("&");

    return `${base}?${queryString}`;
}

export default function ParamsPanel() {
    const { request, updateField, resolveString } = useRequestBuilderContext();

    // Handle params change and sync to URL
    const handleParamsChange = useCallback((newParams: KeyValueItem[]) => {
        updateField("params", newParams);

        // Sync to URL
        const newUrl = buildUrlWithParams(request.url, newParams);
        updateField("url", newUrl);
    }, [request.url, updateField]);

    // Extract base URL for display
    const baseUrl = useMemo(() => {
        const queryStart = request.url.indexOf('?');
        return queryStart === -1 ? request.url : request.url.slice(0, queryStart);
    }, [request.url]);

    const resolvedUrl = resolveString(request.url);

    return (
        <div className="space-y-4">
            {/* Base URL Preview */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Base URL</label>
                <div className="p-3 bg-muted rounded-md font-mono text-sm break-all">
                    {resolveString(baseUrl) || <span className="text-muted-foreground italic">No URL</span>}
                </div>
            </div>

            {/* Query Parameters Editor */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Query Parameters</label>
                <KeyValueEditor
                    items={request.params}
                    onChange={handleParamsChange}
                    keyPlaceholder="Parameter"
                    valuePlaceholder="Value"
                    showResolved={true}
                    allowDisable={true}
                />
            </div>

            {/* Full Resolved URL */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Full Resolved URL</label>
                <div className="p-3 bg-muted rounded-md font-mono text-sm break-all">
                    {resolvedUrl || <span className="text-muted-foreground italic">No URL</span>}
                </div>
            </div>
        </div>
    );
}

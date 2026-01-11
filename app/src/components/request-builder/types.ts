/**
 * RequestBuilder Types
 * 
 * Centralized type definitions for the request builder module
 */

import type { HttpMethod } from "@/types";

// ============================================================================
// Key-Value Types (shared across params, headers, form-data)
// ============================================================================

export interface KeyValueItem {
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    description?: string;
}

// ============================================================================
// Tab Types
// ============================================================================

export type RequestTab = 
    | "params" 
    | "headers" 
    | "body" 
    | "auth" 
    | "pre-script" 
    | "test-script";

export interface TabInfo {
    id: RequestTab;
    label: string;
    badge?: number;
}

// ============================================================================
// Auth Types
// ============================================================================

export type AuthType = "none" | "bearer" | "basic" | "api-key";

export interface AuthConfig {
    type: AuthType;
    bearer?: {
        token: string;
    };
    basic?: {
        username: string;
        password: string;
    };
    apiKey?: {
        key: string;
        value: string;
        addTo: "header" | "query";
    };
}

// ============================================================================
// Body Types
// ============================================================================

export type BodyMode = "none" | "json" | "text" | "form-data" | "x-www-form-urlencoded";

export interface BodyConfig {
    mode: BodyMode;
    raw?: string;
    formData?: KeyValueItem[];
    urlEncoded?: KeyValueItem[];
}

// ============================================================================
// Request State
// ============================================================================

export interface RequestState {
    // Identity
    id: string | null;
    collectionId: string | null;
    name: string;
    description?: string;
    
    // Request
    method: HttpMethod;
    url: string;
    params: KeyValueItem[];
    headers: KeyValueItem[];
    
    // Body (flattened for easier access)
    bodyMode: BodyMode;
    body: string;  // Raw body content (JSON, text)
    formData: KeyValueItem[];
    urlEncoded: KeyValueItem[];
    
    // Auth
    authType: AuthType;
    authConfig: Record<string, any>;
    
    // Scripts
    preRequestScript: string;
    testScript: string;
}

// ============================================================================
// Response Types
// ============================================================================

export interface ResponseState {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    requestHeaders?: Record<string, string>;
    rawRequest?: string;
    body: string;
    bodyType: "json" | "html" | "xml" | "text" | "binary";
    size: number;
    time: number;
    timestamp?: string;
    // Script execution results
    consoleLogs?: string[];
    testResults?: Array<{ name: string; passed: boolean; error?: string }>;
    preScriptError?: string;
    postScriptError?: string;
}

// ============================================================================
// Context Types
// ============================================================================

export interface RequestBuilderContextValue {
    // Request State
    request: RequestState;
    setRequest: (request: Partial<RequestState>) => void;
    updateField: <K extends keyof RequestState>(field: K, value: RequestState[K]) => void;
    
    // Response State
    response: ResponseState | null;
    setResponse: (response: ResponseState | null) => void;
    
    // UI State
    activeTab: RequestTab;
    setActiveTab: (tab: RequestTab) => void;
    isExecuting: boolean;
    isSaving: boolean;
    hasUnsavedChanges: boolean;
    saveStatus: 'idle' | 'saving' | 'saved';
    
    // Variable Resolution
    resolveString: (input: string) => string;
    resolveVariables: (input: string) => string;
    getVariable: (name: string) => VariableInfo | null;
    getAllVariables: () => Record<string, VariableInfo>;
    updateVariable: (name: string, value: string, scope: VariableScope) => void;
    
    // Actions
    executeRequest: () => Promise<void>;
    saveRequest: () => Promise<void>;
    startLoadTest: () => void;
}

export interface VariableInfo {
    value: string;
    scope: VariableScope;
}

export type VariableScope = "global" | "collection" | "environment";

// ============================================================================
// Component Props Types
// ============================================================================

export interface KeyValueEditorProps {
    items: KeyValueItem[];
    onChange: (items: KeyValueItem[]) => void;
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    showResolved?: boolean;
    allowDisable?: boolean;
    readOnly?: boolean;
    keySuggestions?: string[];  // Optional autocomplete suggestions for the key field
}

export interface ScriptEditorProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    height?: string;
    readOnly?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

export const generateId = (): string => 
    Math.random().toString(36).substring(2, 11);

export const createEmptyKeyValue = (): KeyValueItem => ({
    id: generateId(),
    key: "",
    value: "",
    enabled: true,
});

export const createDefaultRequestState = (): RequestState => ({
    id: null,
    collectionId: null,
    name: "Untitled Request",
    method: "GET",
    url: "",
    params: [createEmptyKeyValue()],
    headers: [createEmptyKeyValue()],
    bodyMode: "none",
    body: "",
    formData: [createEmptyKeyValue()],
    urlEncoded: [createEmptyKeyValue()],
    authType: "none",
    authConfig: {},
    preRequestScript: "",
    testScript: "",
});

// Convert KeyValueItem[] to Record<string, string>
export const keyValueToRecord = (items: KeyValueItem[]): Record<string, string> => {
    const result: Record<string, string> = {};
    items.forEach(item => {
        if (item.enabled && item.key.trim()) {
            result[item.key] = item.value;
        }
    });
    return result;
};

// Convert Record<string, string> to KeyValueItem[]
export const recordToKeyValue = (record: Record<string, string> | undefined): KeyValueItem[] => {
    if (!record || Object.keys(record).length === 0) {
        return [createEmptyKeyValue()];
    }
    return Object.entries(record).map(([key, value]) => ({
        id: generateId(),
        key,
        value,
        enabled: true,
    }));
};

/**
 * UrlBar Component
 * 
 * The main URL input bar containing:
 * - HTTP method selector
 * - URL input with variable support
 * - Action buttons (Send, Load Test)
 * - Auto-save status indicator
 */

import { Play, Zap, Loader2, Check } from "lucide-react";
import { Button } from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import MethodSelector from "./MethodSelector";
import UrlInput from "./UrlInput";

export default function UrlBar() {
    const {
        request,
        isExecuting,
        hasUnsavedChanges,
        saveStatus,
        executeRequest,
        startLoadTest,
    } = useRequestBuilderContext();

    const canExecute = !isExecuting && request.url.trim().length > 0;

    return (
        <div className="flex items-center gap-2 p-4 border-b border-border bg-card">
            {/* Method Selector */}
            <MethodSelector />

            {/* URL Input */}
            <UrlInput />

            {/* Send Button */}
            <Button
                onClick={executeRequest}
                disabled={!canExecute}
                className="min-w-[100px]"
            >
                {isExecuting ? (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Sending
                    </>
                ) : (
                    <>
                        <Play className="w-4 h-4 mr-2" />
                        Send
                    </>
                )}
            </Button>

            {/* Load Test Button */}
            <Button
                variant="secondary"
                onClick={startLoadTest}
                disabled={!canExecute}
                className="bg-purple-600 text-white hover:bg-purple-700"
            >
                <Zap className="w-4 h-4 mr-2" />
                Load Test
            </Button>

            {/* Auto-save Status */}
            <div className="flex items-center gap-2 px-3 text-sm text-muted-foreground">
                {saveStatus === 'saving' && (
                    <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving...</span>
                    </>
                )}
                {saveStatus === 'saved' && (
                    <>
                        <Check className="w-4 h-4 text-green-600" />
                        <span className="text-green-600">Saved</span>
                    </>
                )}
                {saveStatus === 'idle' && !hasUnsavedChanges && (
                    <span className="text-xs">Auto-saves as you type</span>
                )}
            </div>
        </div>
    );
}

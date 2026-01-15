/**
 * SampleRequestCard Component
 * 
 * Displays a single sampled request with expandable details.
 */

import { CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import TimingBreakdown from "./TimingBreakdown";
import { UnifiedResponseViewer } from "@/components/shared/response-viewer";
import type { SampleResult } from "../types";

interface SampleRequestCardProps {
    sample: SampleResult;
    index: number;
    isExpanded: boolean;
    onToggle: () => void;
}

export default function SampleRequestCard({ sample, index, isExpanded, onToggle }: SampleRequestCardProps) {
    const formatTimestamp = (ts: string | number) => {
        const date = new Date(ts);
        return date.toLocaleString();
    };

    const isError = !!sample.error || sample.statusCode === 0;
    const isSuccess = sample.statusCode >= 200 && sample.statusCode < 300;

    return (
        <div className={cn(
            "border rounded-lg overflow-hidden transition-all",
            isError && "border-destructive/30",
            isSuccess && "border-green-500/20"
        )}>
            {/* Header - Always Visible */}
            <button
                onClick={onToggle}
                className="w-full flex items-center gap-3 p-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
            >
                <span className="text-xs font-mono text-muted-foreground w-8">#{index + 1}</span>

                {isError ? (
                    <XCircle className="w-4 h-4 text-destructive shrink-0" />
                ) : (
                    <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                )}

                <Badge variant={isError ? "destructive" : isSuccess ? "default" : "outline"} className="font-mono text-xs">
                    {sample.statusCode === 0 ? 'ERR' : sample.statusCode}
                </Badge>

                <span className="text-sm font-medium font-mono">{sample.latencyMs.toFixed(1)}ms</span>

                <span className="text-xs text-muted-foreground ml-auto">{formatTimestamp(sample.timestamp)}</span>

                <div className={cn(
                    "w-2 h-2 rounded-full transition-transform",
                    isExpanded && "rotate-180"
                )}>
                    <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-muted-foreground" />
                </div>
            </button>

            {/* Expanded Details */}
            {isExpanded && (
                <div className="p-4 space-y-4 bg-card border-t">
                    {/* Error Message */}
                    {sample.error && (
                        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                            <p className="text-xs font-medium text-destructive mb-1">Error</p>
                            <p className="text-sm text-destructive font-mono break-all">{sample.error}</p>
                        </div>
                    )}

                    {/* Timing Breakdown */}
                    {sample.trace && (
                        <div>
                            <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Timing Breakdown</h4>
                            <TimingBreakdown
                                dnsMs={sample.trace.dnsMs}
                                connectMs={sample.trace.connectMs}
                                tlsMs={sample.trace.tlsMs}
                                firstByteMs={sample.trace.firstByteMs}
                                downloadMs={sample.trace.downloadMs}
                                compact
                            />
                        </div>
                    )}

                    {/* Request Headers */}
                    {sample.trace?.request?.headers && (
                        <div>
                            <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Request Headers</h4>
                            <pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40">
                                {typeof sample.trace.request.headers === 'object'
                                    ? JSON.stringify(sample.trace.request.headers, null, 2)
                                    : sample.trace.request.headers}
                            </pre>
                        </div>
                    )}

                    {/* Response using UnifiedResponseViewer */}
                    {(sample.trace?.response?.body || sample.trace?.response?.headers) && (
                        <UnifiedResponseViewer
                            response={{
                                body: typeof sample.trace.response.body === 'object'
                                    ? JSON.stringify(sample.trace.response.body, null, 2)
                                    : sample.trace.response.body || '',
                                headers: sample.trace.response.headers || {},
                                status: sample.statusCode,
                            }}
                            compact
                            showActions={false}
                            hiddenTabs={["request"]}
                            className="max-h-[400px]"
                        />
                    )}
                </div>
            )}
        </div>
    );
}

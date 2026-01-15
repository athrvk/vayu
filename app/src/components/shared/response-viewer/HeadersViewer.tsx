/**
 * HeadersViewer Component
 * 
 * Displays HTTP headers in a collapsible table format.
 * Used for both request and response headers.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
    Badge,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { HeadersViewerProps } from "./types";

export default function HeadersViewer({
    headers,
    title,
    defaultOpen = true,
    variant = "response",
    className,
}: HeadersViewerProps) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const entries = Object.entries(headers);

    if (entries.length === 0) {
        return null;
    }

    const colorClass = variant === "response" ? "text-green-500" : "text-blue-500";

    return (
        <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full text-left group">
                <div className="flex items-center justify-center w-5 h-5 rounded bg-muted group-hover:bg-muted/80 transition-colors">
                    {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    ) : (
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    )}
                </div>
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {title || (variant === "response" ? "Response Headers" : "Request Headers")}
                </h3>
                <Badge variant="outline" className="ml-auto text-xs">
                    {entries.length}
                </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Name</th>
                            <th className="text-left py-2 px-3 font-medium text-muted-foreground">Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map(([name, value]) => (
                            <tr key={name} className="border-b border-border/50 hover:bg-muted/50">
                                <td className={cn("py-2 px-3 font-mono", colorClass)}>{name}</td>
                                <td className="py-2 px-3 font-mono break-all">{value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </CollapsibleContent>
        </Collapsible>
    );
}

/**
 * Compact headers display for smaller views
 */
export function CompactHeadersViewer({
    headers,
    title,
    className,
}: {
    headers: Record<string, string>;
    title?: string;
    className?: string;
}) {
    const entries = Object.entries(headers);

    if (entries.length === 0) {
        return null;
    }

    return (
        <div className={className}>
            {title && (
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">{title}</h4>
            )}
            <div className="bg-muted rounded-lg p-3 space-y-1">
                {entries.map(([key, value]) => (
                    <div key={key} className="flex gap-2 py-1 border-b border-border/50 last:border-0">
                        <span className="text-xs font-medium text-primary shrink-0">{key}:</span>
                        <span className="text-xs text-foreground break-all">{value}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

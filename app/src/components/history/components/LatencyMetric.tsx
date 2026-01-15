/**
 * LatencyMetric Component
 * 
 * Displays a latency metric with color coding based on variant.
 */

import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";

interface LatencyMetricProps {
    label: string;
    value: number;
    variant?: "default" | "primary" | "warning" | "danger";
}

export default function LatencyMetric({ label, value, variant = "default" }: LatencyMetricProps) {
    const colorClass = {
        default: "text-foreground",
        primary: "text-blue-600 dark:text-blue-400",
        warning: "text-orange-600 dark:text-orange-400",
        danger: "text-red-600 dark:text-red-400",
    }[variant];

    const bgClass = {
        default: "bg-muted/50",
        primary: "bg-blue-50 dark:bg-blue-950/30",
        warning: "bg-orange-50 dark:bg-orange-950/30",
        danger: "bg-red-50 dark:bg-red-950/30",
    }[variant];

    return (
        <div className={cn("p-3 rounded-lg text-center", bgClass)}>
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className={cn("text-lg font-bold", colorClass)}>
                {formatNumber(value)}
                <span className="text-xs ml-0.5">ms</span>
            </p>
        </div>
    );
}

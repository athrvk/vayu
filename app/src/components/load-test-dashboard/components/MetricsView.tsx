/**
 * MetricsView Component
 * 
 * Displays key metrics, latency breakdown, and charts
 */

import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import type { MetricsViewProps } from "../types";

// Color classes for metric cards
const colorClasses = {
    blue: "bg-blue-50 border-blue-200 text-blue-900 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-100",
    red: "bg-red-50 border-red-200 text-red-900 dark:bg-red-950 dark:border-red-800 dark:text-red-100",
    green: "bg-green-50 border-green-200 text-green-900 dark:bg-green-950 dark:border-green-800 dark:text-green-100",
    purple: "bg-purple-50 border-purple-200 text-purple-900 dark:bg-purple-950 dark:border-purple-800 dark:text-purple-100",
};

function KeyMetricCard({
    label,
    value,
    color,
}: {
    label: string;
    value: string;
    color: keyof typeof colorClasses;
}) {
    return (
        <div className={cn("p-4 rounded-lg border", colorClasses[color])}>
            <p className="text-sm font-medium opacity-75 mb-1">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
        </div>
    );
}

export default function MetricsView({ metrics, historicalMetrics, isCompleted }: MetricsViewProps) {
    if (!metrics || typeof metrics.requests_completed === 'undefined') {
        return (
            <div className="text-center py-12 text-muted-foreground">
                <Activity className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
                <p>Waiting for metrics...</p>
            </div>
        );
    }

    const successRate =
        metrics.requests_completed > 0
            ? ((metrics.requests_completed - (metrics.requests_failed || 0)) /
                metrics.requests_completed) *
            100
            : 0;

    // Prepare chart data - deduplicated by second
    const dataBySecond = new Map<number, { time: number; rps: number; concurrency: number }>();
    historicalMetrics.forEach((m) => {
        const second = Math.round(m.elapsed_seconds);
        dataBySecond.set(second, {
            time: second,
            rps: m.current_rps,
            concurrency: m.current_concurrency,
        });
    });

    // Convert to array and sort by time
    const chartData = Array.from(dataBySecond.values()).sort((a, b) => a.time - b.time);

    return (
        <div className="space-y-6">
            {/* Key Metrics */}
            <div className="grid grid-cols-4 gap-4">
                <KeyMetricCard
                    label="Total Requests"
                    value={formatNumber(metrics.requests_completed)}
                    color="blue"
                />
                <KeyMetricCard
                    label="Failed"
                    value={formatNumber(metrics.requests_failed ?? 0)}
                    color="red"
                />
                <KeyMetricCard
                    label="Success Rate"
                    value={`${successRate.toFixed(1)}%`}
                    color="green"
                />
                <KeyMetricCard
                    label={isCompleted ? "Avg RPS" : "Current RPS"}
                    value={formatNumber(Math.round(metrics.current_rps ?? 0))}
                    color="purple"
                />
            </div>

            {/* Latency Metrics */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">Latency</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-4 gap-4">
                        <div>
                            <p className="text-sm text-muted-foreground">Average</p>
                            <p className="text-2xl font-bold text-foreground">
                                {(metrics.avg_latency_ms ?? 0).toFixed(2)}ms
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">P50</p>
                            {isCompleted ? (
                                <p className="text-2xl font-bold text-foreground">
                                    {(metrics.latency_p50_ms ?? 0).toFixed(2)}ms
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground italic">Calculating...</p>
                            )}
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">P95</p>
                            {isCompleted ? (
                                <p className="text-2xl font-bold text-foreground">
                                    {(metrics.latency_p95_ms ?? 0).toFixed(2)}ms
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground italic">Calculating...</p>
                            )}
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">P99</p>
                            {isCompleted ? (
                                <p className="text-2xl font-bold text-foreground">
                                    {(metrics.latency_p99_ms ?? 0).toFixed(2)}ms
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground italic">Calculating...</p>
                            )}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Charts */}
            {chartData.length > 1 && (
                <>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">Requests per Second</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                    <XAxis
                                        dataKey="time"
                                        label={{
                                            value: "Time (s)",
                                            position: "insideBottom",
                                            offset: -5,
                                        }}
                                    />
                                    <YAxis
                                        label={{ value: "RPS", angle: -90, position: "insideLeft" }}
                                    />
                                    <Tooltip />
                                    <Line
                                        type="monotone"
                                        dataKey="rps"
                                        stroke="hsl(var(--primary))"
                                        strokeWidth={2}
                                        dot={false}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">Active Connections</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ResponsiveContainer width="100%" height={300}>
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                                    <XAxis
                                        dataKey="time"
                                        label={{
                                            value: "Time (s)",
                                            position: "insideBottom",
                                            offset: -5,
                                        }}
                                    />
                                    <YAxis
                                        label={{
                                            value: "Connections",
                                            angle: -90,
                                            position: "insideLeft",
                                            offset: 5,
                                        }}
                                    />
                                    <Tooltip />
                                    <Line
                                        type="monotone"
                                        dataKey="concurrency"
                                        stroke="hsl(var(--chart-2))"
                                        strokeWidth={2}
                                        dot={false}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}


/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoricalChartsSection Component
 *
 * Displays time-series charts for historical load test runs.
 * Uses Recharts for visualization with client-side downsampling for large datasets.
 */

import { useMemo } from "react";
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { Loader2 } from "lucide-react";
import type { LoadTestMetrics } from "@/types";

interface HistoricalChartsSectionProps {
    data: LoadTestMetrics[];
    isLoading?: boolean;
    isFetchingMore?: boolean;
    progress?: { loaded: number; total: number };
}

/**
 * Downsample data for chart rendering performance.
 * Keeps every Nth point to cap at maxPoints while preserving first and last points.
 */
function downsample<T>(data: T[], maxPoints: number = 2000): T[] {
    if (data.length <= maxPoints) return data;

    const step = Math.ceil(data.length / maxPoints);
    const result: T[] = [];

    for (let i = 0; i < data.length; i += step) {
        result.push(data[i]);
    }

    // Ensure last point is included
    if (result[result.length - 1] !== data[data.length - 1]) {
        result.push(data[data.length - 1]);
    }

    return result;
}

/**
 * Prepare chart data from LoadTestMetrics array.
 * Groups by elapsed_seconds and downsamples for rendering.
 * Note: Latency metrics are not stored periodically, only as final summary.
 */
function prepareChartData(metrics: LoadTestMetrics[]) {
    // Deduplicate by second (keep latest value per second)
    const dataBySecond = new Map<
        number,
        {
            time: number;
            rps: number;
            concurrency: number;
            errorRate: number;
            throughput: number;
        }
    >();

    metrics.forEach((m) => {
        const second = Math.round(m.elapsed_seconds);
        const errorRate =
            m.requests_completed > 0
                ? ((m.requests_failed || 0) / m.requests_completed) * 100
                : 0;

        dataBySecond.set(second, {
            time: second,
            rps: m.current_rps,
            concurrency: m.current_concurrency,
            errorRate,
            throughput: m.throughput ?? 0,
        });
    });

    // Convert to sorted array and downsample
    const sorted = Array.from(dataBySecond.values()).sort((a, b) => a.time - b.time);
    return downsample(sorted, 2000);
}

export default function HistoricalChartsSection({
    data,
    isLoading,
    isFetchingMore,
    progress,
}: HistoricalChartsSectionProps) {
    const chartData = useMemo(() => prepareChartData(data), [data]);

    if (isLoading && data.length === 0) {
        return (
            <Card>
                <CardContent className="flex items-center justify-center py-12">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin" />
                        <p>Loading time-series data...</p>
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (chartData.length < 2) {
        return (
            <Card>
                <CardContent className="flex items-center justify-center py-8">
                    <p className="text-muted-foreground">
                        Insufficient data points for charts (need at least 2 seconds of data)
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            {/* Loading indicator for pagination */}
            {isFetchingMore && progress && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>
                        Loading more data... ({progress.loaded.toLocaleString()} /{" "}
                        {progress.total.toLocaleString()} points)
                    </span>
                </div>
            )}

            {/* RPS Chart */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Requests per Second</CardTitle>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis
                                dataKey="time"
                                label={{
                                    value: "Time (s)",
                                    position: "insideBottom",
                                    offset: -5,
                                }}
                                tick={{ fontSize: 12 }}
                            />
                            <YAxis
                                label={{ value: "RPS", angle: -90, position: "insideLeft" }}
                                tick={{ fontSize: 12 }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "hsl(var(--card))",
                                    border: "1px solid hsl(var(--border))",
                                    borderRadius: "6px",
                                }}
                                labelFormatter={(value: number) => `Time: ${value}s`}
                            />
                            <Line
                                type="monotone"
                                dataKey="rps"
                                stroke="hsl(var(--primary))"
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                name="RPS"
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* Throughput Chart */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Throughput (Responses/s)</CardTitle>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis
                                dataKey="time"
                                label={{
                                    value: "Time (s)",
                                    position: "insideBottom",
                                    offset: -5,
                                }}
                                tick={{ fontSize: 12 }}
                            />
                            <YAxis
                                label={{
                                    value: "Throughput",
                                    angle: -90,
                                    position: "insideLeft",
                                    offset: 10,
                                }}
                                tick={{ fontSize: 12 }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "hsl(var(--card))",
                                    border: "1px solid hsl(var(--border))",
                                    borderRadius: "6px",
                                }}
                                labelFormatter={(value: number) => `Time: ${value}s`}
                                formatter={(value: number) => [`${value.toFixed(1)} req/s`, "Throughput"]}
                            />
                            <Line
                                type="monotone"
                                dataKey="throughput"
                                stroke="hsl(var(--chart-2))"
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                name="Throughput"
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* Connections Chart */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-base">Active Connections</CardTitle>
                </CardHeader>
                <CardContent>
                    <ResponsiveContainer width="100%" height={250}>
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                            <XAxis
                                dataKey="time"
                                label={{
                                    value: "Time (s)",
                                    position: "insideBottom",
                                    offset: -5,
                                }}
                                tick={{ fontSize: 12 }}
                            />
                            <YAxis
                                label={{
                                    value: "Connections",
                                    angle: -90,
                                    position: "insideLeft",
                                    offset: 5,
                                }}
                                tick={{ fontSize: 12 }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: "hsl(var(--card))",
                                    border: "1px solid hsl(var(--border))",
                                    borderRadius: "6px",
                                }}
                                labelFormatter={(value: number) => `Time: ${value}s`}
                            />
                            <Line
                                type="monotone"
                                dataKey="concurrency"
                                stroke="hsl(var(--chart-3))"
                                strokeWidth={2}
                                dot={false}
                                isAnimationActive={false}
                                name="Connections"
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>
        </div>
    );
}

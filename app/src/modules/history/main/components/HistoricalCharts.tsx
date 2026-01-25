
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HistoricalCharts Component
 *
 * Displays time-series charts for historical load test runs using data from /stats endpoint.
 */

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import {
	LineChart,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	ResponsiveContainer,
	Legend,
} from "recharts";
import { useHistoricalMetrics } from "../hooks";

interface HistoricalChartsProps {
	runId: string;
}

export default function HistoricalCharts({ runId }: HistoricalChartsProps) {
	const { metrics, isLoading, error } = useHistoricalMetrics(runId);

	// Prepare chart data - deduplicated by second
	const chartData = useMemo(() => {
		if (!metrics.length) return [];

		const dataBySecond = new Map<
			number,
			{
				time: number;
				rps: number;
				concurrency: number;
				latency: number;
				throughput: number;
				sendRate: number;
			}
		>();

		metrics.forEach((m) => {
			const second = Math.round(m.elapsedSeconds);
			dataBySecond.set(second, {
				time: second,
				rps: m.currentRps,
				concurrency: m.activeConnections,
				latency: m.avgLatencyMs,
				throughput: m.throughput,
				sendRate: m.sendRate,
			});
		});

		return Array.from(dataBySecond.values()).sort((a, b) => a.time - b.time);
	}, [metrics]);

	if (isLoading) {
		return (
			<Card>
				<CardContent className="flex items-center justify-center py-12">
					<div className="flex items-center gap-2 text-muted-foreground">
						<Loader2 className="w-5 h-5 animate-spin" />
						<span>Loading historical metrics...</span>
					</div>
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					<p>Unable to load historical charts</p>
					<p className="text-xs mt-1">{error}</p>
				</CardContent>
			</Card>
		);
	}

	if (chartData.length < 2) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					<p>Not enough data points to display charts</p>
					<p className="text-xs mt-1">
						Charts require at least 2 data points over time
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* RPS Over Time */}
			<Card>
				<CardHeader>
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
							/>
							<YAxis
								label={{ value: "RPS", angle: -90, position: "insideLeft" }}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "hsl(var(--card))",
									border: "1px solid hsl(var(--border))",
								}}
							/>
							<Line
								type="monotone"
								dataKey="rps"
								stroke="hsl(var(--primary))"
								strokeWidth={2}
								dot={false}
								name="RPS"
							/>
						</LineChart>
					</ResponsiveContainer>
				</CardContent>
			</Card>

			{/* Throughput vs Send Rate */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Throughput vs Send Rate</CardTitle>
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
							/>
							<YAxis
								label={{
									value: "req/s",
									angle: -90,
									position: "insideLeft",
								}}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "hsl(var(--card))",
									border: "1px solid hsl(var(--border))",
								}}
							/>
							<Legend />
							<Line
								type="monotone"
								dataKey="sendRate"
								stroke="hsl(var(--chart-1))"
								strokeWidth={2}
								dot={false}
								name="Send Rate"
							/>
							<Line
								type="monotone"
								dataKey="throughput"
								stroke="hsl(var(--chart-2))"
								strokeWidth={2}
								dot={false}
								name="Throughput"
							/>
						</LineChart>
					</ResponsiveContainer>
				</CardContent>
			</Card>

			{/* Active Connections */}
			<Card>
				<CardHeader>
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
							/>
							<YAxis
								label={{
									value: "Connections",
									angle: -90,
									position: "insideLeft",
									offset: 5,
								}}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "hsl(var(--card))",
									border: "1px solid hsl(var(--border))",
								}}
							/>
							<Line
								type="monotone"
								dataKey="concurrency"
								stroke="hsl(var(--chart-3))"
								strokeWidth={2}
								dot={false}
								name="Connections"
							/>
						</LineChart>
					</ResponsiveContainer>
				</CardContent>
			</Card>

			{/* Average Latency Over Time */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Average Latency Over Time</CardTitle>
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
							/>
							<YAxis
								label={{
									value: "Latency (ms)",
									angle: -90,
									position: "insideLeft",
								}}
							/>
							<Tooltip
								contentStyle={{
									backgroundColor: "hsl(var(--card))",
									border: "1px solid hsl(var(--border))",
								}}
							/>
							<Line
								type="monotone"
								dataKey="latency"
								stroke="hsl(var(--chart-4))"
								strokeWidth={2}
								dot={false}
								name="Avg Latency"
							/>
						</LineChart>
					</ResponsiveContainer>
				</CardContent>
			</Card>
		</div>
	);
}

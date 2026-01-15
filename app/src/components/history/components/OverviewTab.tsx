/**
 * OverviewTab Component
 * 
 * Displays test configuration, summary statistics, status codes, and errors.
 */

import { Activity, CheckCircle, XCircle, Zap, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import MetricCard from "./MetricCard";
import type { TabProps } from "../types";

export default function OverviewTab({ report }: TabProps) {
    return (
        <>
            {/* Test Configuration */}
            {report.metadata && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Test Configuration</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {report.metadata.configuration?.comment && (
                            <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
                                <p className="text-xs text-primary font-medium mb-1">Comment</p>
                                <p className="text-sm text-foreground">{report.metadata.configuration.comment}</p>
                            </div>
                        )}
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                            <div>
                                <p className="text-xs text-muted-foreground mb-1">Request URL</p>
                                <p className="text-sm font-medium text-foreground break-all">
                                    {report.metadata.requestUrl}
                                </p>
                            </div>
                            <div>
                                <p className="text-xs text-muted-foreground mb-1">Method</p>
                                <Badge variant="outline" className="text-xs">
                                    {report.metadata.requestMethod}
                                </Badge>
                            </div>
                            {report.metadata.configuration && (
                                <>
                                    {report.metadata.configuration.mode && (
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Mode</p>
                                            <p className="text-sm font-medium text-foreground capitalize">
                                                {report.metadata.configuration.mode}
                                            </p>
                                        </div>
                                    )}
                                    {report.metadata.configuration.duration && (
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Configured Duration</p>
                                            <p className="text-sm font-medium text-foreground">
                                                {report.metadata.configuration.duration}
                                            </p>
                                        </div>
                                    )}
                                    {report.metadata.configuration.concurrency && (
                                        <div>
                                            <p className="text-xs text-muted-foreground mb-1">Concurrency</p>
                                            <p className="text-sm font-medium text-foreground">
                                                {report.metadata.configuration.concurrency} workers
                                            </p>
                                        </div>
                                    )}
                                </>
                            )}
                            {report.summary.testDuration !== undefined && report.summary.testDuration > 0 && (
                                <div>
                                    <p className="text-xs text-muted-foreground mb-1">Actual Duration</p>
                                    <p className="text-sm font-medium text-foreground">
                                        {report.summary.testDuration.toFixed(2)}s
                                        {report.summary.setupOverhead !== undefined && report.summary.setupOverhead > 0 && (
                                            <span className="text-xs text-muted-foreground ml-1">
                                                (+{(report.summary.setupOverhead * 1000).toFixed(0)}ms setup)
                                            </span>
                                        )}
                                    </p>
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Summary Statistics */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <MetricCard
                    icon={<Activity className="w-5 h-5 text-primary" />}
                    label="Total Requests"
                    value={formatNumber(report.summary.totalRequests)}
                />
                <MetricCard
                    icon={<CheckCircle className="w-5 h-5 text-green-500" />}
                    label="Successful"
                    value={formatNumber(report.summary.totalRequests - report.summary.failedRequests)}
                />
                <MetricCard
                    icon={<XCircle className="w-5 h-5 text-destructive" />}
                    label="Failed"
                    value={formatNumber(report.summary.failedRequests)}
                    className={report.summary.failedRequests > 0 ? "bg-destructive/5 border-destructive/20" : ""}
                />
                <MetricCard
                    icon={<Zap className="w-5 h-5 text-blue-500" />}
                    label="Avg RPS"
                    value={formatNumber(report.summary.avgRps)}
                />
            </div>

            {/* Status Codes */}
            {report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Status Code Distribution</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                            {Object.entries(report.statusCodes).map(([code, count]) => {
                                const isError = code === "0";
                                const isSuccess = code.startsWith("2");
                                const isRedirect = code.startsWith("3");
                                const isClientError = code.startsWith("4");
                                const isServerError = code.startsWith("5");

                                return (
                                    <div
                                        key={code}
                                        className={cn(
                                            "p-3 rounded-lg border text-center",
                                            isError && "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
                                            isSuccess && "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900",
                                            isRedirect && "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900",
                                            isClientError && "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-900",
                                            isServerError && "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
                                            !isError && !isSuccess && !isRedirect && !isClientError && !isServerError && "bg-muted border-border"
                                        )}
                                    >
                                        <p className={cn(
                                            "text-lg font-bold font-mono mb-0.5",
                                            isError && "text-red-700 dark:text-red-400",
                                            isSuccess && "text-green-700 dark:text-green-400",
                                            isRedirect && "text-blue-700 dark:text-blue-400",
                                            isClientError && "text-yellow-700 dark:text-yellow-400",
                                            isServerError && "text-red-700 dark:text-red-400"
                                        )}>
                                            {isError ? "ERR" : code}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {formatNumber(count)} reqs
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Errors */}
            {report.errors && report.errors.total > 0 && (
                <Card className="border-destructive/30">
                    <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2 text-destructive">
                            <AlertCircle className="w-5 h-5" />
                            Error Summary
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
                            <span className="text-sm font-medium text-destructive">Total Errors</span>
                            <span className="text-lg font-bold text-destructive">
                                {formatNumber(report.errors.total)} ({report.summary.errorRate.toFixed(2)}%)
                            </span>
                        </div>

                        {report.errors.types && Object.entries(report.errors.types).length > 0 && (
                            <div className="space-y-2">
                                <p className="text-xs font-medium text-muted-foreground">By Error Type</p>
                                {Object.entries(report.errors.types).map(([errorType, count]) => (
                                    <div
                                        key={errorType}
                                        className="flex justify-between items-center p-2 bg-muted rounded text-sm"
                                    >
                                        <span className="capitalize">{errorType.replace(/_/g, ' ')}</span>
                                        <span className="font-medium">{formatNumber(count as number)}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {report.errors.byStatusCode && Object.entries(report.errors.byStatusCode).length > 0 && (
                            <div className="space-y-2">
                                <p className="text-xs font-medium text-muted-foreground">By Status Code</p>
                                {Object.entries(report.errors.byStatusCode).map(([code, count]) => (
                                    <div
                                        key={code}
                                        className="flex justify-between items-center p-2 bg-muted rounded text-sm"
                                    >
                                        <span className="font-mono">
                                            {code === "0" ? "Network/Connection" : `HTTP ${code}`}
                                        </span>
                                        <span className="font-medium">{formatNumber(count as number)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}
        </>
    );
}

/**
 * RequestResponseView Component
 * 
 * Displays status codes, errors, timing breakdown, and validation results
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RequestResponseViewProps } from "../types";

export default function RequestResponseView({ report }: RequestResponseViewProps) {
    if (!report) {
        return (
            <div className="text-center py-12 text-gray-500">
                <p>Request/Response view available after test completion</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* Status Code Distribution */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">Status Code Distribution</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-4 gap-4">
                        {Object.entries(report.statusCodes || {}).map(([code, count]) => (
                            <div key={code} className="p-3 bg-muted rounded">
                                <span className={cn(
                                    "font-mono font-bold",
                                    code.startsWith('2') && 'text-green-600 dark:text-green-400',
                                    code.startsWith('3') && 'text-blue-600 dark:text-blue-400',
                                    code.startsWith('4') && 'text-yellow-600 dark:text-yellow-400',
                                    code.startsWith('5') && 'text-red-600 dark:text-red-400'
                                )}>{code}</span>
                                <p className="text-sm text-muted-foreground">{String(count)} requests</p>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* Error Details */}
            {report.errors && report.errors.total > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Error Summary</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Total Errors:</span>
                                <span className="font-semibold text-destructive">{report.errors.total}</span>
                            </div>
                            {Object.entries(report.errors.types || {}).map(([type, count]) => (
                                <div key={type} className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">{type}:</span>
                                    <span className="font-medium">{String(count)}</span>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Timing Breakdown */}
            {report.timingBreakdown && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Timing Breakdown</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-5 gap-4">
                            <div>
                                <p className="text-sm text-muted-foreground">DNS</p>
                                <p className="font-bold">{report.timingBreakdown.avgDnsMs.toFixed(2)}ms</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Connect</p>
                                <p className="font-bold">{report.timingBreakdown.avgConnectMs.toFixed(2)}ms</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">TLS</p>
                                <p className="font-bold">{report.timingBreakdown.avgTlsMs.toFixed(2)}ms</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">First Byte</p>
                                <p className="font-bold">{report.timingBreakdown.avgFirstByteMs.toFixed(2)}ms</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Download</p>
                                <p className="font-bold">{report.timingBreakdown.avgDownloadMs.toFixed(2)}ms</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Slow Requests */}
            {report.slowRequests && report.slowRequests.count > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Slow Requests</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-3 gap-4">
                            <div>
                                <p className="text-sm text-muted-foreground">Slow Requests</p>
                                <p className="font-bold text-orange-600 dark:text-orange-400">{report.slowRequests.count}</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Threshold</p>
                                <p className="font-bold">{report.slowRequests.thresholdMs}ms</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Percentage</p>
                                <p className="font-bold">{report.slowRequests.percentage.toFixed(2)}%</p>
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">
                            Requests that exceeded the configured threshold and were automatically captured
                        </p>
                    </CardContent>
                </Card>
            )}

            {/* Test Validation Results */}
            {report.testValidation && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Test Validation</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-4 gap-4">
                            <div>
                                <p className="text-sm text-muted-foreground">Samples Tested</p>
                                <p className="font-bold">{report.testValidation.samplesTested}</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Passed</p>
                                <p className="font-bold text-green-600 dark:text-green-400">{report.testValidation.testsPassed}</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Failed</p>
                                <p className="font-bold text-destructive">{report.testValidation.testsFailed}</p>
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Success Rate</p>
                                <p className="font-bold">{report.testValidation.successRate.toFixed(1)}%</p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

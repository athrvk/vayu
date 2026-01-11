/**
 * DashboardHeader Component
 * 
 * Header with title, status badge, and stop button
 */

import { Activity, StopCircle, Loader2 } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import type { DashboardHeaderProps } from "../types";

export default function DashboardHeader({
    mode,
    isStreaming,
    isStopping,
    onStop,
}: DashboardHeaderProps) {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
                <Activity className="w-6 h-6 text-purple-600" />
                <h2 className="text-xl font-semibold text-foreground">
                    Load Test Dashboard
                </h2>
                {isStreaming && (
                    <Badge variant="outline" className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300 border-green-200">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse mr-2" />
                        Live
                    </Badge>
                )}
                {mode === "completed" && (
                    <Badge variant="secondary">Completed</Badge>
                )}
            </div>

            <div className="flex items-center gap-2">
                {mode === "running" && (
                    <Button
                        variant="destructive"
                        onClick={onStop}
                        disabled={isStopping}
                    >
                        {isStopping ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                Stopping...
                            </>
                        ) : (
                            <>
                                <StopCircle className="w-4 h-4 mr-2" />
                                Stop Test
                            </>
                        )}
                    </Button>
                )}
            </div>
        </div>
    );
}

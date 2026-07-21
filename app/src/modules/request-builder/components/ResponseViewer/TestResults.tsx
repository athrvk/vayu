/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TestResults Component
 *
 * Displays test execution results with pass/fail status.
 */

import { CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface TestResultsProps {
	results: Array<{ name: string; passed: boolean; error?: string }>;
}

export default function TestResults({ results }: TestResultsProps) {
	const passedCount = results.filter((t) => t.passed).length;
	const failedCount = results.length - passedCount;

	return (
		<div className="p-4 overflow-auto h-full">
			{/* Summary */}
			<div className="mb-4 flex items-center gap-4">
				<Badge variant={failedCount === 0 ? "default" : "destructive"} className="text-sm">
					{passedCount} passed, {failedCount} failed
				</Badge>
			</div>

			{/* Test List */}
			<div className="space-y-2">
				{results.map((test, i) => (
					<div
						key={i}
						className={cn(
							"p-3 border",
							test.passed
								? "bg-status-success/10 border-status-success/20"
								: "bg-status-error/10 border-status-error/20"
						)}
					>
						<div className="flex items-start gap-2">
							{test.passed ? (
								<CheckCircle className="w-5 h-5 text-status-success-text mt-0.5 flex-shrink-0" />
							) : (
								<XCircle className="w-5 h-5 text-status-error-text mt-0.5 flex-shrink-0" />
							)}
							<div className="flex-1">
								<p
									className={cn(
										"text-sm font-medium",
										test.passed
											? "text-status-success-text"
											: "text-status-error-text"
									)}
								>
									{test.name}
								</p>
								{test.error && (
									<p className="text-sm text-status-error-text mt-1 font-mono">
										{test.error}
									</p>
								)}
							</div>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

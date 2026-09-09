/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's `control.transaction` percentiles (issue #1515) - one row per
 * declared name that closed at least once, each a folder's members summed
 * into one latency distribution rather than reported per step.
 *
 * Silent when the run recorded none - an absent card, not an empty one, for
 * a collection with no `control.transaction` element and for a report from
 * an engine that predates this field.
 *
 * Two surfaces show it, the same two {@link CustomMetricsSummary} does - the
 * load run report's Overview tab and the scenario run view - so it lives
 * here once.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import type { RunTransactionSummary } from "@/types/domain";

function formatMs(value: number): string {
	return `${value.toFixed(1)}ms`;
}

export interface TransactionsSummaryProps {
	transactions: RunTransactionSummary[] | undefined;
	className?: string;
}

export function TransactionsSummary({ transactions, className }: TransactionsSummaryProps) {
	if (!transactions || transactions.length === 0) return null;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>Transactions</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="space-y-1.5">
					{transactions.map((transaction) => (
						<li
							key={transaction.name}
							className="flex items-baseline justify-between gap-3 text-sm"
						>
							<span className="text-muted-foreground">
								<span className="font-mono">{transaction.name}</span>
								<span className="ml-1.5 text-xs">
									({transaction.count} run{transaction.count === 1 ? "" : "s"}
									{transaction.errors > 0
										? `, ${transaction.errors} error${transaction.errors === 1 ? "" : "s"}`
										: ""}
									)
								</span>
							</span>
							<span className="font-mono font-medium">
								p50 {formatMs(transaction.latency.p50)} / p95{" "}
								{formatMs(transaction.latency.p95)} / max{" "}
								{formatMs(transaction.latency.max)}
							</span>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

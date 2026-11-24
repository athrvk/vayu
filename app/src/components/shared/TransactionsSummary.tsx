/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's `control.transaction` percentiles (#1515): one row per declared name that closed at least
 * once, a folder's members summed into one latency distribution rather than per step. Silent
 * without any (no `control.transaction` element, or an engine predating the field): an absent card,
 * not an empty one. Shown on the same two surfaces as {@link CustomMetricsSummary} (the load
 * report's Overview, the scenario run view), so it lives once.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatLatency } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunTransactionSummary } from "@/types/domain";

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
									({transaction.count} {pluralize(transaction.count, "run")}
									{transaction.errors > 0
										? `, ${transaction.errors} ${pluralize(transaction.errors, "error")}`
										: ""}
									)
								</span>
							</span>
							<span className="font-mono font-medium">
								p50 {formatLatency(transaction.latency.p50)} / p95{" "}
								{formatLatency(transaction.latency.p95)} / max{" "}
								{formatLatency(transaction.latency.max)}
							</span>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}

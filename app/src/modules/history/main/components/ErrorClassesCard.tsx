/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's failed MCP replies by class: transport, protocol and tool, and the
 * JSON-RPC codes behind the protocol ones (`summary.errorClasses`, #3828).
 *
 * Absent for a run with nothing to say, and that is two different runs: the key
 * missing is a run stored before the engine counted classes, `{}` is one that
 * counted and saw no failed reply. A card of zeros would read as a finding for
 * the second and as a measurement for the first, so both draw nothing. Every
 * class is drawn once any is counted, because a 0 beside a 12 is information.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import { ERROR_CLASS_KEYS } from "@/lib/run-compare";
import type { ErrorClassCounts } from "@/types";
import { ERROR_CLASS_HINTS, ERROR_CLASS_LABELS } from "./error-classes";

/** `-32602` as a number sorts the codes; "other" holds every code outside the named bands and goes last. */
function sortedCodes(codes: Record<string, number>): [string, number][] {
	const rank = (code: string) => (code === "other" ? Infinity : Number(code));
	return Object.entries(codes).sort(([a], [b]) => {
		const [ra, rb] = [rank(a), rank(b)];
		return ra === rb ? 0 : ra < rb ? -1 : 1;
	});
}

export function ErrorClassesCard({ errorClasses }: { errorClasses: ErrorClassCounts | undefined }) {
	if (!errorClasses || !ERROR_CLASS_KEYS.some((key) => (errorClasses[key] ?? 0) > 0)) return null;
	const codes = sortedCodes(errorClasses.protocolCodes ?? {});

	return (
		<Card className="enter-fade">
			<CardHeader>
				<CardTitle>Error classes</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<div className="grid grid-cols-3 gap-3">
					{ERROR_CLASS_KEYS.map((key) => (
						<div key={key} className="p-3 border border-rule text-center">
							<p className="text-lg font-bold font-mono mb-0.5">
								{formatNumber(errorClasses[key] ?? 0)}
							</p>
							<p className="text-xs font-medium">{ERROR_CLASS_LABELS[key]}</p>
							<p className="text-xs text-muted-foreground">
								{ERROR_CLASS_HINTS[key]}
							</p>
						</div>
					))}
				</div>
				{codes.length > 0 && (
					<div className="space-y-1">
						<p className="text-xs font-medium text-muted-foreground">
							JSON-RPC error codes
						</p>
						<ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
							{codes.map(([code, count]) => (
								<li key={code}>
									<span className="font-mono">{code}</span>{" "}
									<span className="text-muted-foreground">
										{formatNumber(count)}
									</span>
								</li>
							))}
						</ul>
					</div>
				)}
				<p className="text-xs text-muted-foreground">
					Failed MCP replies by class. Each is also counted in the error totals.
				</p>
			</CardContent>
		</Card>
	);
}

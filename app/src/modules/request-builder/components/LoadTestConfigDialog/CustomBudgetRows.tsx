/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `custom.<name>.<stat>` budget rows (issue #1579).
 *
 * One component, mounted by both dialogs that declare budgets, for the reason
 * `budgets.ts` and `NumberField` are shared rather than copied: a second copy
 * of a repeatable-row list stops receiving this one's fixes, and the two
 * dialogs would drift on what a half-filled row means.
 *
 * The metric name is typed, not picked from a list. The engine validates the
 * key's *shape* and not that the name is one this run records
 * (`docs/engine/api-reference.md`, the thresholds block), so a picker would
 * have to resolve every `metric.record` element down the collection chain to
 * offer a choice the engine does not require - plumbing neither dialog has, for
 * no correctness gain. The stat is a closed set, so that half is a select.
 */

import { Plus, X } from "lucide-react";
import {
	Button,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import {
	CUSTOM_BUDGET_STATS,
	type CustomBudgetDraft,
	type CustomBudgetStat,
	emptyCustomBudgetRow,
} from "./budgets";

export interface CustomBudgetRowsProps {
	rows: CustomBudgetDraft[];
	onChange: (rows: CustomBudgetDraft[]) => void;
	/**
	 * Namespaces every DOM id this renders. Both dialogs pass their own, the
	 * rule `NumberField`'s callers already keep, so the two cannot collide if
	 * they are ever mounted together.
	 */
	idPrefix: string;
	disabled?: boolean;
}

export function CustomBudgetRows({ rows, onChange, idPrefix, disabled }: CustomBudgetRowsProps) {
	const update = (id: string, patch: Partial<CustomBudgetDraft>) =>
		onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

	return (
		<div className="space-y-2">
			{rows.length > 0 && (
				/*
				 * Column captions rather than a label per control: a label on
				 * every row would print "Metric name" once per budget. The
				 * captions are `aria-hidden` and each control carries its own
				 * `aria-label` naming the row, so what a screen reader hears is
				 * unambiguous where sighted reading is by column.
				 */
				<div
					className="flex items-center gap-2 text-[11px] text-muted-foreground"
					aria-hidden="true"
				>
					<span className="min-w-0 flex-1">Metric name</span>
					<span className="w-24">Stat</span>
					<span className="w-24">At most</span>
					{/* The remove button's column, so the captions line up with the fields. */}
					<span className="w-9" />
				</div>
			)}

			{rows.map((row, index) => (
				<div key={row.id} className="flex items-center gap-2">
					<Input
						id={`${idPrefix}-custom-budget-name-${row.id}`}
						type="text"
						value={row.name}
						onChange={(e) => update(row.id, { name: e.target.value })}
						placeholder="checkout_ttfb"
						aria-label={`Custom budget ${index + 1} metric name`}
						className="h-9 min-w-0 flex-1 text-sm"
						disabled={disabled}
					/>
					<Select
						value={row.stat}
						onValueChange={(value) =>
							update(row.id, { stat: value as CustomBudgetStat })
						}
						disabled={disabled}
					>
						<SelectTrigger
							id={`${idPrefix}-custom-budget-stat-${row.id}`}
							className="h-9 w-24 shrink-0 text-sm"
							aria-label={`Custom budget ${index + 1} stat`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CUSTOM_BUDGET_STATS.map((stat) => (
								<SelectItem key={stat} value={stat}>
									{stat}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						id={`${idPrefix}-custom-budget-value-${row.id}`}
						type="number"
						inputMode="numeric"
						min={0}
						value={row.value}
						onChange={(e) => update(row.id, { value: e.target.value })}
						placeholder="No budget"
						aria-label={`Custom budget ${index + 1} ceiling`}
						className="h-9 w-24 shrink-0 text-sm"
						disabled={disabled}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="shrink-0"
						aria-label={`Remove custom budget ${index + 1}`}
						onClick={() => onChange(rows.filter((other) => other.id !== row.id))}
						disabled={disabled}
					>
						<X className="h-4 w-4" />
					</Button>
				</div>
			))}

			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => onChange([...rows, emptyCustomBudgetRow()])}
				disabled={disabled}
			>
				<Plus className="mr-1.5 h-3.5 w-3.5" />
				Add custom metric budget
			</Button>
		</div>
	);
}

/** The one sentence both dialogs say above the rows. */
export function CustomBudgetHint() {
	return (
		<p className="text-[11px] leading-relaxed text-muted-foreground">
			A ceiling on a value the run records itself - a metric.record element or a pm.metrics
			call - under the name it is recorded with. A name this run never records is reported as
			unevaluated rather than passing quietly.
		</p>
	);
}

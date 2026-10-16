/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, type Dispatch, type SetStateAction } from "react";
import { Label, Switch } from "@/components/ui";
import { CopyForAgentButton, NumberField } from "@/components/shared";
import { thresholdReference, type ThresholdOwner } from "@/lib/agent-reference";
import { DisclosureCard } from "./DisclosureCard";
import {
	BUDGETS_EXPLAINER,
	BUDGET_FIELDS,
	summariseBudgets,
	type BudgetDraft,
	type CustomBudgetDraft,
} from "./budgets";
import { CustomBudgetHint, CustomBudgetRows } from "./CustomBudgetRows";

interface BudgetsSectionProps {
	budgets: BudgetDraft;
	onBudgetsChange: Dispatch<SetStateAction<BudgetDraft>>;
	customBudgets: CustomBudgetDraft[];
	onCustomBudgetsChange: (rows: CustomBudgetDraft[]) => void;
	failRun: boolean;
	onFailRunChange: (value: boolean) => void;
	/** Locks the custom rows while the run is starting. */
	disabled: boolean;
	/** The saved request the budgets belong to; "Copy for agent" is absent without it. */
	referenceOwner?: ThresholdOwner;
}

/** The run's pass/fail limits: the fixed fields, the custom rows, and what a miss does. */
export function BudgetsSection({
	budgets,
	onBudgetsChange,
	customBudgets,
	onCustomBudgetsChange,
	failRun,
	onFailRunChange,
	disabled,
	referenceOwner,
}: BudgetsSectionProps) {
	const [open, setOpen] = useState(false);

	return (
		<DisclosureCard
			open={open}
			onOpenChange={setOpen}
			title="Pass/fail budgets"
			summary={summariseBudgets(budgets, customBudgets)}
		>
			<p className="text-label leading-relaxed text-muted-foreground">{BUDGETS_EXPLAINER}</p>
			{BUDGET_FIELDS.map((field) => (
				<NumberField
					key={field.key}
					id={field.id}
					label={field.label}
					unit={field.unit}
					optional
					value={budgets[field.key]}
					onChange={(raw) => onBudgetsChange((prev) => ({ ...prev, [field.key]: raw }))}
					min={field.min}
					max={field.max}
					placeholder="No budget"
					hint={field.seededHint ?? field.hint}
					action={
						referenceOwner && (
							<CopyForAgentButton
								reference={thresholdReference({ key: field.key }, referenceOwner)}
								label={`Copy ${field.label} for agent`}
							/>
						)
					}
				/>
			))}

			{/*
			 * The custom rows sit below the fixed six and above the flag, which is
			 * the reading order of the section: the six every run can declare, then
			 * the ones this plan records, then what a miss does.
			 */}
			<div className="space-y-1.5">
				<Label className="text-xs">
					Custom metric budgets
					<span className="ml-1 font-normal text-muted-foreground">(optional)</span>
				</Label>
				<CustomBudgetHint />
				<CustomBudgetRows
					rows={customBudgets}
					onChange={onCustomBudgetsChange}
					idPrefix="lt"
					disabled={disabled}
					referenceOwner={referenceOwner}
				/>
			</div>

			<div className="flex items-start justify-between gap-3">
				<Label htmlFor="lt-fail-run" className="text-xs font-normal leading-snug">
					Fail the run when a budget is missed
					<span className="block text-label text-muted-foreground">
						Otherwise a missed budget is reported but the run still ends Completed.
					</span>
				</Label>
				<Switch id="lt-fail-run" checked={failRun} onCheckedChange={onFailRunChange} />
			</div>
		</DisclosureCard>
	);
}

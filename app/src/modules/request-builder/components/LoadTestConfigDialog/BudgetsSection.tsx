/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Fragment, useState, type Dispatch, type SetStateAction } from "react";
import { Label, Switch } from "@/components/ui";
import { CopyForAgentButton, NumberField } from "@/components/shared";
import { thresholdReference, type ThresholdOwner } from "@/lib/agent-reference";
import { DisclosureCard } from "./DisclosureCard";
import type { LoadTestConfig } from "@/types";
import {
	BUDGETS_EXPLAINER,
	CAPACITY_BUDGETS_NOTE,
	CAPACITY_SEED_HINT,
	STREAM_LATENCY_NOTE,
	STREAM_LATENCY_NOTE_AFTER,
	budgetFieldsFor,
	summariseBudgets,
	type BudgetDraft,
	type BudgetField,
	type CustomBudgetDraft,
} from "./budgets";
import {
	SLO_SEEDED_KEY,
	budgetsToSend,
	isUnsentSeed,
	type CarriedBudgets,
} from "./carried-budgets";
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
	mode: LoadTestConfig["mode"];
	/** Where each still-carried field came from, so the Settings p99 seed can be told from a typed one. */
	budgetSources: CarriedBudgets["fixed"];
	/** Whether the request streams: the stream budgets are offered only then. */
	isStreamingRequest: boolean;
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
	mode,
	budgetSources,
	isStreamingRequest,
}: BudgetsSectionProps) {
	const [open, setOpen] = useState(false);
	const seedUnsent = isUnsentSeed(mode, budgetSources);
	const hintFor = (field: BudgetField) =>
		field.key === SLO_SEEDED_KEY && seedUnsent
			? CAPACITY_SEED_HINT
			: (field.seededHint ?? field.hint);

	return (
		<DisclosureCard
			open={open}
			onOpenChange={setOpen}
			title="Pass/fail budgets"
			summary={summariseBudgets(
				budgetsToSend(budgets, mode, budgetSources),
				customBudgets,
				isStreamingRequest
			)}
		>
			<p className="text-label leading-relaxed text-muted-foreground">{BUDGETS_EXPLAINER}</p>
			{mode === "capacity" && (
				<p className="text-label leading-relaxed text-muted-foreground">
					{CAPACITY_BUDGETS_NOTE}
				</p>
			)}
			{budgetFieldsFor(isStreamingRequest).map((field) => (
				<Fragment key={field.key}>
					<NumberField
						id={field.id}
						label={field.label}
						unit={field.unit}
						optional
						value={budgets[field.key]}
						onChange={(raw) =>
							onBudgetsChange((prev) => ({ ...prev, [field.key]: raw }))
						}
						min={field.min}
						max={field.max}
						placeholder="No budget"
						hint={hintFor(field)}
						action={
							referenceOwner && (
								<CopyForAgentButton
									reference={thresholdReference(
										{ key: field.key },
										referenceOwner
									)}
									label={`Copy ${field.label} for agent`}
								/>
							)
						}
					/>
					{isStreamingRequest && field.key === STREAM_LATENCY_NOTE_AFTER && (
						<p className="text-label leading-relaxed text-muted-foreground">
							{STREAM_LATENCY_NOTE}
						</p>
					)}
				</Fragment>
			))}

			{/*
			 * The custom rows sit below the fixed fields and above the flag, which is
			 * the reading order of the section: the fixed ones a run can declare, then
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

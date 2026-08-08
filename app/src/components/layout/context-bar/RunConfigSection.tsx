/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What this run was asked to do: its mode, its target, and its caps.
 *
 * Read from the run's stored `configSnapshot` - the sanitized copy of the body
 * that started it - so it says what ran, not what the request holds now.
 *
 * The load-test pane draws a config strip of its own, so on a load run this
 * section restates part of it. That is deliberate rather than overlooked: a
 * *design* run has no config view anywhere, and a bar that changed shape
 * between the two kinds of run tab would be the worse answer. Names come from
 * `loadTestModeLabel` / `formatConcurrency`, the same helpers that strip uses,
 * so the two cannot word the same run differently.
 *
 * A **collection run** states its work in a `scenario` block instead of a mode
 * and a target, and every load-test key above is absent from its snapshot - so
 * reading it the load way produced no rows at all and the section said "No
 * configuration was recorded", of a run that recorded plenty. Its rows come
 * from that block, and the step list itself stays in `ScenarioRunView`: this is
 * what was asked for, not what happened.
 */

import { useRunQuery } from "@/queries";
import { loadTestModeLabel, formatConcurrency } from "@/constants/load-test-modes";
import { HTTP_VERSIONS, isHttpVersion } from "@/constants/request";
import { SectionEmpty, SectionLoading } from "./Section";
import { scenarioFromSnapshot } from "./run-scenario";
import type { ContextBarSectionProps } from "./types";
import type { ReactNode } from "react";

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-2">
			<span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
			<span className="text-xs font-mono text-foreground truncate">{children}</span>
		</div>
	);
}

export function RunConfigSection({ tab }: ContextBarSectionProps) {
	const { data: run, isLoading } = useRunQuery(tab.entityId);

	if (isLoading && !run) return <SectionLoading />;
	if (!run) return <SectionEmpty>This run is no longer available</SectionEmpty>;

	const config = run.configSnapshot;
	const scenario = scenarioFromSnapshot(run);

	if (scenario) {
		const rows: ReactNode[] = [
			<Row key="mode" label="Mode">
				Collection run
			</Row>,
		];
		if (scenario.steps) {
			rows.push(
				<Row key="steps" label="Steps">
					{scenario.steps.length}
				</Row>
			);
		}
		if (scenario.iterations != null) {
			rows.push(
				<Row key="iterations" label="Iterations">
					{scenario.iterations}
				</Row>
			);
		}
		// Both values, not just the true one: whether the run descended into
		// sub-folders is what decides which requests were in it, so "No" is as
		// much of an answer as "Yes" and a missing row would read as neither.
		if (scenario.recursive != null) {
			rows.push(
				<Row key="recursive" label="Sub-folders">
					{scenario.recursive ? "Included" : "Excluded"}
				</Row>
			);
		}
		return <div className="space-y-1">{rows}</div>;
	}

	// A design run's snapshot carries no `mode` key - there is no strategy to
	// record for one send. Naming it here rather than leaving the row out keeps
	// the section from reading as "nothing was recorded" on every design run.
	const mode = run.type === "design" ? "Single send" : loadTestModeLabel(config?.mode);
	const protocol = isHttpVersion(config?.httpVersion)
		? HTTP_VERSIONS.find((v) => v.value === config.httpVersion)?.label
		: undefined;

	const rows: ReactNode[] = [];
	if (mode)
		rows.push(
			<Row key="mode" label="Mode">
				{mode}
			</Row>
		);
	if (config?.duration)
		rows.push(
			<Row key="duration" label="Duration">
				{config.duration}
			</Row>
		);
	if (config?.targetRps != null && config.targetRps > 0) {
		rows.push(
			<Row key="rps" label="Target RPS">
				{config.targetRps}
			</Row>
		);
	}
	if (config?.concurrency != null && config.concurrency > 0) {
		rows.push(
			<Row key="concurrency" label="Concurrency">
				{formatConcurrency(config.concurrency)}
			</Row>
		);
	}
	if (config?.iterations != null && config.iterations > 0) {
		rows.push(
			<Row key="iterations" label="Iterations">
				{config.iterations}
			</Row>
		);
	}
	if (config?.rampUpDuration) {
		rows.push(
			<Row key="ramp" label="Ramp">
				{config.rampUpDuration}
			</Row>
		);
	}
	if (config?.startConcurrency != null && config.startConcurrency > 0) {
		rows.push(
			<Row key="start" label="Starting at">
				{formatConcurrency(config.startConcurrency)}
			</Row>
		);
	}
	// The protocol the run *asked for*. The negotiated one is per exchange and
	// has no single value across a load run - see `LoadTestDetail`.
	if (protocol)
		rows.push(
			<Row key="protocol" label="Protocol">
				{protocol}
			</Row>
		);

	if (rows.length === 0) {
		return <SectionEmpty>No configuration was recorded for this run</SectionEmpty>;
	}

	return <div className="space-y-1">{rows}</div>;
}

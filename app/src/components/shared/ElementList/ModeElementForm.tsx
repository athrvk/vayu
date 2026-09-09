/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bespoke form for a kind whose schema declares several **mutually
 * exclusive strategies** as independent optional siblings: `assert.status`,
 * `assert.jsonpath`, `timer.think`, `control.throughput` and
 * `metric.record`'s `source` (`element-modes.ts` holds the table, and each
 * entry names the engine function its priority was read from).
 *
 * One form for all five, not five forms: the difference between them is data
 * (which keys belong to which strategy, in which order the engine resolves
 * them), and every one of them wants the same three things - pick a strategy,
 * see only that strategy's fields, and leave nothing of the others behind.
 *
 * **The fields are still the generic form's.** Each part of this form is a
 * {@link GenericElementForm} over a subset of the kind's own schema, so
 * `title`, `description`, `x-vayu-unit`, `x-vayu-group: advanced`,
 * required-first ordering and the two-short-fields-per-line pairing all arrive
 * unchanged and from one implementation - a mode's fields look like every
 * other row in the card because they *are* those rows.
 *
 * **The picker is a segmented control up to three modes, a dropdown past
 * that** - the split `SettingControls.tsx` already draws between a few options
 * a user browses and a set that reads as a list. `metric.record`'s six sources
 * are the only ones on the far side of it, and six segments would not fit an
 * element card's width at any reasonable label length.
 *
 * **The picker's state is the config, not a `useState`.** The mode on screen
 * is whatever the engine would resolve from `config` ({@link detectMode});
 * the local `picked` is consulted only while a just-chosen mode has no key yet
 * (a mode switch clears the others and writes nothing of its own until the
 * user types), so nothing can drift out of step with what will actually run.
 */

import { useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { SelectSettingRow } from "@/modules/settings/main/panels/SettingControls";
import type { ElementConfigProperty, ElementConfigSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";
import {
	ELEMENT_MODES,
	detectMode,
	switchMode,
	type ElementMode,
	type ElementModeSpec,
} from "./element-modes";

/**
 * Modes shown as segments rather than a dropdown. Three is what an element
 * card's width holds beside the picker's own label.
 */
const SEGMENTED_MAX = 3;

export interface ModeElementFormProps {
	kind: string;
	/**
	 * The kind's `configSchema`. Optional for the same reason `ElementRow`
	 * renders a "no longer registered" line rather than throwing: an element
	 * can name a kind this engine build no longer serves, and the form is
	 * handed whatever the catalogue had.
	 */
	schema?: ElementConfigSchema;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
}

const EMPTY_SCHEMA: ElementConfigSchema = { type: "object", properties: {} };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * The named properties of `schema` as a schema of their own, carrying only the
 * `required` entries that survived the cut. A name the catalogue does not
 * declare (an older engine build) is dropped rather than rendered blank.
 */
function subsetSchema(
	properties: Record<string, ElementConfigProperty | null | undefined>,
	required: string[] | undefined,
	names: string[]
): ElementConfigSchema {
	const kept: Record<string, ElementConfigProperty | null> = {};
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(properties, name)) {
			kept[name] = properties[name] ?? null;
		}
	}
	return {
		type: "object",
		properties: kept,
		required: (required ?? []).filter((name) => name in kept),
	};
}

/** A nested `object` property as the schema of its own level. */
function nestedSchema(property: ElementConfigProperty | null | undefined): ElementConfigSchema {
	return {
		type: "object",
		properties: property?.properties ?? {},
		required: property?.required,
	};
}

function ModePicker({
	spec,
	value,
	description,
	onChange,
}: {
	spec: ElementModeSpec;
	value: string;
	description?: string;
	onChange: (mode: string) => void;
}) {
	if (spec.modes.length > SEGMENTED_MAX) {
		return (
			<SelectSettingRow
				label={spec.pickerLabel}
				description={description}
				value={value}
				onChange={onChange}
				options={spec.modes.map((mode) => ({ value: mode.id, label: mode.label }))}
				compact
			/>
		);
	}
	return (
		<div className="space-y-1" data-element-mode-picker={spec.pickerLabel}>
			<div className="flex items-center gap-2">
				{/*
				 * A `<span>`, not a `<Label>`: a segmented control is a group of
				 * buttons with no single labelable control to point `htmlFor` at,
				 * so the group carries its own `aria-label` from the same string
				 * (the shape `ExportSpecDialog` uses).
				 */}
				<span className="text-xs font-medium">{spec.pickerLabel}</span>
				<ToggleGroup
					value={value}
					// Radix clears the value when the active segment is pressed
					// again; a strategy has no "off" - one of them always runs.
					onValueChange={(next) => next && onChange(next)}
					size="xs"
					aria-label={spec.pickerLabel}
				>
					{spec.modes.map((mode) => (
						<ToggleGroupItem key={mode.id} value={mode.id}>
							{mode.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
		</div>
	);
}

/** The active mode's own fields, at whichever level the modes live on. */
function ModeFields({
	mode,
	properties,
	required,
	config,
	onChange,
}: {
	mode: ElementMode;
	properties: Record<string, ElementConfigProperty | null | undefined>;
	required: string[] | undefined;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
}) {
	// A marker mode has nothing to render: the engine reads the key's
	// presence, never its value, so the picker *is* the field. Its schema
	// description still carries the one sentence explaining the strategy,
	// which the picker's own hint renders above.
	if (mode.render === "marker") return null;

	if (mode.render === "nested") {
		const nested = nestedSchema(properties[mode.id]);
		if (Object.keys(nested.properties ?? {}).length === 0) return null;
		return (
			<GenericElementForm
				schema={nested}
				config={asRecord(config[mode.id])}
				onChange={(next) => onChange({ ...config, [mode.id]: next })}
			/>
		);
	}

	const subset = subsetSchema(properties, required, [mode.id, ...(mode.also ?? [])]);
	if (Object.keys(subset.properties ?? {}).length === 0) return null;
	return <GenericElementForm schema={subset} config={config} onChange={onChange} />;
}

export function ModeElementForm({ kind, schema, config, onChange }: ModeElementFormProps) {
	// Only consulted while the chosen mode has written nothing yet - see the
	// module comment. `null` until the picker is used at all.
	const [picked, setPicked] = useState<string | null>(null);
	const spec = ELEMENT_MODES[kind];

	// A kind routed here with no entry in the table is a wiring mistake, not a
	// dead end for the user: fall back to the form every other kind gets.
	if (!spec) {
		return (
			<GenericElementForm
				schema={schema ?? EMPTY_SCHEMA}
				config={config}
				onChange={onChange}
			/>
		);
	}

	const properties = schema?.properties ?? {};
	const levelProperty = spec.path ? properties[spec.path] : undefined;
	const levelProperties = spec.path ? (levelProperty?.properties ?? {}) : properties;
	const levelRequired = spec.path ? levelProperty?.required : schema?.required;
	const levelConfig = spec.path ? asRecord(config[spec.path]) : config;
	const writeLevel = (next: Record<string, unknown>) =>
		spec.path ? onChange({ ...config, [spec.path]: next }) : onChange(next);

	const activeId = detectMode(spec, levelConfig) ?? picked ?? spec.defaultMode;
	const mode = spec.modes.find((m) => m.id === activeId) ?? spec.modes[0];

	const chooseMode = (nextId: string) => {
		setPicked(nextId);
		writeLevel(switchMode(spec, levelConfig, nextId));
	};

	// The picker's hint is the mode's own schema `description` for the two
	// shapes whose fields cannot carry it: a marker (no field at all) and a
	// nested object (rendered without the generic form's fieldset, which is
	// where that sentence would otherwise sit). A plain field mode already
	// prints its description under its own label.
	const pickerHint =
		mode.render === "fields" ? undefined : (levelProperties[mode.id]?.description ?? undefined);

	const lead = subsetSchema(properties, schema?.required, spec.leadNames ?? []);
	const trail = subsetSchema(properties, schema?.required, spec.trailNames ?? []);

	return (
		<div className="space-y-2">
			{Object.keys(lead.properties ?? {}).length > 0 && (
				<GenericElementForm schema={lead} config={config} onChange={onChange} />
			)}
			<ModePicker
				spec={spec}
				value={mode.id}
				description={pickerHint}
				onChange={chooseMode}
			/>
			<ModeFields
				mode={mode}
				properties={levelProperties}
				required={levelRequired}
				config={levelConfig}
				onChange={writeLevel}
			/>
			{Object.keys(trail.properties ?? {}).length > 0 && (
				<GenericElementForm schema={trail} config={config} onChange={onChange} />
			)}
		</div>
	);
}

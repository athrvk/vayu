/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The default element form (issue #1512): one row per property of the kind's
 * `configSchema`, generated the way `SettingsMain.tsx` renders a config entry
 * by type - never a hand-written form per kind. A kind the app has never seen
 * is editable the day the engine ships it, which is the whole point of the
 * catalogue being schema-carrying rather than a label list.
 *
 * **Labels come from the schema, not the property key** (issue #1608). Every
 * property in the engine's catalogue carries `title` and `description` since
 * issue #1607 - a property with neither (a kind an older engine build still
 * serves) falls back to its raw key, the same "still editable" guarantee the
 * kind-level fallback already gives. A `required` property renders before an
 * optional one; one marked `x-vayu-group: "advanced"` renders under a
 * disclosure instead, open on mount only when the element already has a
 * value for one - closed for a fresh element, so the common fields are what
 * a user sees first. `x-vayu-unit` becomes the numeric field's suffix.
 *
 * One level of `object` nesting is supported (`assert.status.range`'s
 * `{min, max}`) - see {@link ElementConfigProperty}. Anything deeper, or a
 * form richer than {@link groupRows}' one-or-two fields per line, ships a
 * bespoke override instead (`elementForms.ts`).
 *
 * **Two adjacent short fields share a line** ({@link groupRows}). A pair of
 * bounds is one idea - `assert.status.range`'s `{min, max}` is "200 to 299" -
 * and stacking a label, a hint sentence and an input twice over spent most of
 * an expanded card on two integers.
 */

import { useId } from "react";
import { ChevronRight } from "lucide-react";
import {
	NumberSettingRow,
	SelectSettingRow,
	ToggleRow,
} from "@/modules/settings/main/panels/SettingControls";
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Input, Label } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ElementConfigProperty, ElementConfigSchema } from "@/types";

export interface GenericElementFormProps {
	schema: ElementConfigSchema;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
}

function asString(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function setField(
	config: Record<string, unknown>,
	key: string,
	value: unknown
): Record<string, unknown> {
	return { ...config, [key]: value };
}

/**
 * Whether this property's control is short enough to share a line with the one
 * beside it.
 *
 * A number spinner and an enum dropdown are, at every width an element card is
 * drawn at: their content is a handful of characters or a menu the widest
 * option already fits. A string, an array's comma-separated list and a nested
 * object are not - a JSONPath, a variable name or a regular expression has no
 * length bound, and half a line for one of those is a worse trade than the
 * line it saves. A boolean is excluded for the opposite reason: `ToggleRow` is
 * *already* horizontal (label left, switch right), so it costs one line either
 * way and halving its width only crowds its description.
 */
function isPairable(property: ElementConfigProperty | null | undefined): boolean {
	if (!property) return false;
	if (property.type === "integer" || property.type === "number") return true;
	return property.type === "string" && (property.enum?.length ?? 0) > 0;
}

/**
 * Groups a form's ordered property names into lines: exactly two adjacent
 * pairable properties share one, everything else keeps a line of its own.
 *
 * **Exactly two, not "as many as fit".** A run of three short fields is a
 * list, not a pair: `timer.think` declares `ms`, `minMs` and `maxMs` - one
 * fixed wait beside the two bounds of a random one - and pairing by position
 * would sit the fixed wait next to a bound it has nothing to do with, which
 * reads as a relationship the schema never declared. Which two of three belong
 * together is knowledge only the kind has, and issue #1512's contract is that
 * this form knows no kinds. A kind that wants that grouping states it the way
 * `assert.status` already does, as a nested `object`, and gets the pair here.
 */
function groupRows(
	names: string[],
	properties: Record<string, ElementConfigProperty | null | undefined>
): string[][] {
	const lines: string[][] = [];
	let run: string[] = [];
	const flush = () => {
		if (run.length === 2) lines.push(run);
		else lines.push(...run.map((name) => [name]));
		run = [];
	};
	for (const name of names) {
		if (isPairable(properties[name])) {
			run.push(name);
			continue;
		}
		flush();
		lines.push([name]);
	}
	flush();
	return lines;
}

/**
 * The rows of one form level - the top-level list, the Advanced disclosure, or
 * a nested object's children - laid out by {@link groupRows}. A fragment, so
 * the caller's own `space-y-*` still separates the lines.
 */
function PropertyRows({
	names,
	properties,
	config,
	onChange,
}: {
	names: string[];
	properties: Record<string, ElementConfigProperty | null | undefined>;
	config: Record<string, unknown>;
	/** The whole level's next value; the caller decides where it is written. */
	onChange: (config: Record<string, unknown>) => void;
}) {
	return (
		<>
			{groupRows(names, properties).map((line) => {
				const rows = line.map((name) => (
					<PropertyRow
						key={name}
						name={name}
						property={properties[name]}
						value={config[name]}
						onChange={(value) => onChange(setField(config, name, value))}
					/>
				));
				if (rows.length === 1) return rows[0];
				return (
					// `grid-cols-2` is `repeat(2, minmax(0, 1fr))`, whose `0`
					// minimum is what lets a long label or hint wrap inside its
					// column instead of widening the track and the card with it
					// (docs/design-system.md, "A grid track has the same default").
					<div key={line[0]} className="grid grid-cols-2 gap-2">
						{rows}
					</div>
				);
			})}
		</>
	);
}

/** One property row, dispatched by the schema's declared type. */
function PropertyRow({
	name,
	property,
	value,
	onChange,
}: {
	name: string;
	/**
	 * JSON Schema allows an unconstrained property to be written as a literal
	 * `null` rather than `{}` - the engine's `assert.jsonpath` kind does this
	 * for `expected`, which can legally hold any JSON value. Typed as
	 * possibly-absent here rather than tightening the schema type upstream, so
	 * a kind whose schema takes this shape still renders instead of throwing
	 * on `property.type` - the same "declares nothing" fallback a bare `{}`
	 * already gets.
	 */
	property: ElementConfigProperty | null | undefined;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	property ??= {};
	const label = property.title ?? name;
	const hint = property.description;
	const unit = property["x-vayu-unit"];
	// Only the two hand-rolled `Label` + `Input` pairs below need this - the
	// settings-row primitives (`ToggleRow`, `NumberSettingRow`,
	// `SelectSettingRow`) already associate their own label internally.
	const inputId = useId();

	if (property.type === "boolean") {
		return (
			<ToggleRow
				label={label}
				description={hint}
				checked={value === true}
				onChange={onChange}
				compact
			/>
		);
	}

	if (property.type === "integer" || property.type === "number") {
		return (
			<NumberSettingRow
				label={label}
				description={hint}
				unit={unit}
				value={asString(value)}
				integer={property.type === "integer"}
				min={property.minimum !== undefined ? String(property.minimum) : undefined}
				max={property.maximum !== undefined ? String(property.maximum) : undefined}
				commit="change"
				compact
				onCommit={(next) => {
					const num = property.type === "integer" ? parseInt(next, 10) : parseFloat(next);
					if (!isNaN(num)) onChange(num);
				}}
			/>
		);
	}

	if (property.type === "string" && property.enum && property.enum.length > 0) {
		return (
			<SelectSettingRow
				label={label}
				description={hint}
				value={asString(value) || property.enum[0]}
				onChange={onChange}
				options={property.enum.map((option) => ({ value: option, label: option }))}
				compact
			/>
		);
	}

	if (property.type === "array") {
		const items = Array.isArray(value) ? value : [];
		const itemType = property.items?.type;
		return (
			<div className="space-y-1">
				<Label htmlFor={inputId} className="text-xs font-medium">
					{label}
				</Label>
				{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				<Input
					id={inputId}
					className="h-8"
					value={items.join(", ")}
					placeholder="Comma-separated values"
					onChange={(e) => {
						const parts = e.target.value
							.split(",")
							.map((part) => part.trim())
							.filter((part) => part.length > 0);
						onChange(
							itemType === "integer"
								? parts.map(Number).filter((n) => !isNaN(n))
								: parts
						);
					}}
				/>
			</div>
		);
	}

	if (property.type === "object" && property.properties) {
		return (
			<fieldset className="space-y-2 rounded-md border border-rule surface-sunken p-2">
				<legend className="px-1 text-xs font-medium">{label}</legend>
				{hint && <p className="px-1 text-xs text-muted-foreground">{hint}</p>}
				<PropertyRows
					names={Object.keys(property.properties)}
					properties={property.properties}
					config={(value as Record<string, unknown> | undefined) ?? {}}
					onChange={onChange}
				/>
			</fieldset>
		);
	}

	// Default: a plain string field, which also covers a kind whose schema
	// declares no type at all - an unknown property is still editable as text
	// rather than silently unrenderable.
	return (
		<div className="space-y-1">
			<Label htmlFor={inputId} className="text-xs font-medium">
				{label}
			</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<Input
				id={inputId}
				className="h-8"
				value={asString(value)}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

export function GenericElementForm({ schema, config, onChange }: GenericElementFormProps) {
	const properties = schema.properties ?? {};
	const names = Object.keys(properties);
	if (names.length === 0) {
		return <p className="text-xs text-muted-foreground">This kind takes no configuration.</p>;
	}

	const required = new Set(schema.required ?? []);
	const advancedNames = names.filter((name) => properties[name]?.["x-vayu-group"] === "advanced");
	const mainNames = names
		.filter((name) => !advancedNames.includes(name))
		.sort((a, b) => Number(!required.has(a)) - Number(!required.has(b)));
	// Open on mount only when the element already carries a value for one -
	// a fresh element starts with the common fields, not a disclosure to find
	// the one already-set advanced property is behind.
	const advancedIsSet = advancedNames.some(
		(name) => Object.prototype.hasOwnProperty.call(config, name) && config[name] !== undefined
	);

	return (
		<div className="space-y-2">
			<PropertyRows
				names={mainNames}
				properties={properties}
				config={config}
				onChange={onChange}
			/>
			{advancedNames.length > 0 && (
				<Collapsible defaultOpen={advancedIsSet}>
					<CollapsibleTrigger
						className={cn(
							"flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground",
							"[&[data-state=open]>svg]:rotate-90"
						)}
					>
						<ChevronRight className="h-3 w-3 transition-transform" />
						Advanced
					</CollapsibleTrigger>
					<CollapsibleContent className="space-y-2 px-1 pt-1.5 pb-1">
						<PropertyRows
							names={advancedNames}
							properties={properties}
							config={config}
							onChange={onChange}
						/>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

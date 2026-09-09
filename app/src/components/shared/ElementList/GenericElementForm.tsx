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
 * form richer than one row per field, ships a bespoke override instead
 * (`elementForms.ts`).
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
			/>
		);
	}

	if (property.type === "array") {
		const items = Array.isArray(value) ? value : [];
		const itemType = property.items?.type;
		return (
			<div className="space-y-1.5">
				<Label htmlFor={inputId} className="text-sm font-medium">
					{label}
				</Label>
				{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				<Input
					id={inputId}
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
			<fieldset className="space-y-3 rounded-md border border-rule surface-sunken p-3">
				<legend className="px-1 text-sm font-medium">{label}</legend>
				{hint && <p className="px-1 text-xs text-muted-foreground">{hint}</p>}
				{Object.entries(property.properties).map(([childName, childProperty]) => (
					<PropertyRow
						key={childName}
						name={childName}
						property={childProperty}
						value={(value as Record<string, unknown> | undefined)?.[childName]}
						onChange={(next) =>
							onChange(
								setField((value as Record<string, unknown>) ?? {}, childName, next)
							)
						}
					/>
				))}
			</fieldset>
		);
	}

	// Default: a plain string field, which also covers a kind whose schema
	// declares no type at all - an unknown property is still editable as text
	// rather than silently unrenderable.
	return (
		<div className="space-y-1.5">
			<Label htmlFor={inputId} className="text-sm font-medium">
				{label}
			</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<Input
				id={inputId}
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
		<div className="space-y-3">
			{mainNames.map((name) => (
				<PropertyRow
					key={name}
					name={name}
					property={properties[name]}
					value={config[name]}
					onChange={(value) => onChange(setField(config, name, value))}
				/>
			))}
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
					<CollapsibleContent className="space-y-3 pt-2">
						{advancedNames.map((name) => (
							<PropertyRow
								key={name}
								name={name}
								property={properties[name]}
								value={config[name]}
								onChange={(value) => onChange(setField(config, name, value))}
							/>
						))}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

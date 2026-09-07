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
 * One level of `object` nesting is supported (`assert.status.range`'s
 * `{min, max}`) - see {@link ElementConfigProperty}. Anything deeper, or a
 * form richer than one row per field, ships a bespoke override instead
 * (`elementForms.ts`).
 */

import {
	NumberSettingRow,
	SelectSettingRow,
	ToggleRow,
} from "@/modules/settings/main/panels/SettingControls";
import { Input, Label } from "@/components/ui";
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
	property: ElementConfigProperty;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	if (property.type === "boolean") {
		return <ToggleRow label={name} checked={value === true} onChange={onChange} />;
	}

	if (property.type === "integer" || property.type === "number") {
		return (
			<NumberSettingRow
				label={name}
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
				label={name}
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
				<Label className="text-sm font-medium">{name}</Label>
				<Input
					value={items.join(", ")}
					placeholder="Comma-separated values"
					onChange={(e) => {
						const parts = e.target.value
							.split(",")
							.map((part) => part.trim())
							.filter((part) => part.length > 0);
						onChange(itemType === "integer" ? parts.map(Number).filter((n) => !isNaN(n)) : parts);
					}}
				/>
			</div>
		);
	}

	if (property.type === "object" && property.properties) {
		return (
			<fieldset className="space-y-3 rounded-md border border-rule surface-sunken p-3">
				<legend className="px-1 text-sm font-medium">{name}</legend>
				{Object.entries(property.properties).map(([childName, childProperty]) => (
					<PropertyRow
						key={childName}
						name={childName}
						property={childProperty}
						value={(value as Record<string, unknown> | undefined)?.[childName]}
						onChange={(next) =>
							onChange(setField((value as Record<string, unknown>) ?? {}, childName, next))
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
			<Label className="text-sm font-medium">{name}</Label>
			<Input value={asString(value)} onChange={(e) => onChange(e.target.value)} />
		</div>
	);
}

export function GenericElementForm({ schema, config, onChange }: GenericElementFormProps) {
	const properties = schema.properties ?? {};
	const names = Object.keys(properties);
	if (names.length === 0) {
		return <p className="text-xs text-muted-foreground">This kind takes no configuration.</p>;
	}
	return (
		<div className="space-y-3">
			{names.map((name) => (
				<PropertyRow
					key={name}
					name={name}
					property={properties[name]}
					value={config[name]}
					onChange={(value) => onChange(setField(config, name, value))}
				/>
			))}
		</div>
	);
}

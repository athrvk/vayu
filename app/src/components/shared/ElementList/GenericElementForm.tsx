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
 * a user sees first. `x-vayu-unit` becomes the numeric field's suffix. A
 * property with no `type` can hold any JSON value, so it takes
 * {@link JsonValueField} instead of a text field (#3046).
 *
 * An `object` that declares no `properties` - `control.switch`'s `cases`, a map
 * from a value to a step name - takes {@link StringMapField}, a key/value row
 * editor (#3047); a text box would save a string where the engine wants an
 * object.
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

import { useId, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import {
	NumberSettingRow,
	SelectSettingRow,
	ToggleRow,
} from "@/modules/settings/main/panels/SettingControls";
import {
	Button,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	ICON_MOTION,
	Input,
	Label,
} from "@/components/ui";
import { FieldError } from "@/components/shared/FieldError";
import { errorsWithin } from "@/lib/elements";
import { cn } from "@/lib/utils";
import type { ElementConfigProperty, ElementConfigSchema } from "@/types";

/** Messages by field name within one form level; a nested object's form gets its own slice. */
type FieldErrors = Readonly<Record<string, string>>;

const NO_ERRORS: FieldErrors = {};

export interface GenericElementFormProps {
	schema: ElementConfigSchema;
	config: Record<string, unknown>;
	onChange: (config: Record<string, unknown>) => void;
	/**
	 * What `validateElementConfig` says is wrong with this level's fields, keyed
	 * by the field's name here (`max`, not `range.max`) - the caller slices a
	 * nested level with `errorsWithin`. Each message shows under its own field.
	 */
	errors?: FieldErrors;
}

function asString(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

/** `JSON.parse` as a result, since the parsed value may itself be `null` or `false`. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/**
 * What an untyped property stores for typed text: the JSON value it spells
 * (`7`, `true`, `null`, `"a"`, `{...}`), or the raw text as a string when it
 * is not JSON. Empty text is the empty string, as the plain field always
 * stored it.
 */
function parseJsonValue(text: string): unknown {
	const parsed = parseJson(text);
	// `1e400` parses to Infinity, which serializes as null: keep the text instead.
	if (parsed.ok && typeof parsed.value === "number" && !Number.isFinite(parsed.value))
		return text;
	return parsed.ok ? parsed.value : text;
}

/**
 * The text that {@link parseJsonValue} turns back into `value`. A string whose
 * raw text is itself JSON (`7`, `true`, `"a"`) is shown quoted, so the stored
 * string round-trips instead of being reinterpreted as a number on the next
 * edit.
 */
function jsonValueText(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value !== "string") return JSON.stringify(value);
	return parseJson(value).ok ? JSON.stringify(value) : value;
}

/** What {@link parseJsonValue} stored, in the words the hint uses; empty text stores nothing worth naming. */
function jsonKindName(value: unknown): string | undefined {
	if (value === "") return undefined;
	if (value === null) return "null";
	if (Array.isArray(value)) return "list";
	if (typeof value === "string") return "text";
	return typeof value;
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
	errors,
	onChange,
}: {
	names: string[];
	properties: Record<string, ElementConfigProperty | null | undefined>;
	config: Record<string, unknown>;
	errors: FieldErrors;
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
						errors={errors}
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

/** An array field's typed text split into items, with the entries that are not one. */
interface ParsedList {
	items: Array<string | number>;
	/** Entries the item type refuses, in typed order; empty when `items` is saveable. */
	invalid: string[];
}

/**
 * Splits comma-separated text into the array a config stores. An `integer`
 * item must read as a whole number: `Number("200.5")` and `Number("0x10")`
 * both succeed, and a value the engine would reject must not be saved looking
 * like one. Any other item type stays a trimmed string.
 */
function parseList(text: string, itemType: string | undefined): ParsedList {
	const parts = text
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (itemType !== "integer") return { items: parts, invalid: [] };
	const items: number[] = [];
	const invalid: string[] = [];
	for (const part of parts) {
		const n = Number(part);
		if (/^-?\d+$/.test(part) && Number.isSafeInteger(n)) items.push(n);
		else invalid.push(part);
	}
	return { items, invalid };
}

/**
 * A comma-separated list field. The text lives in a draft of its own because
 * the stored array cannot spell an unfinished entry: deriving the input from
 * `value` rewrote `200,` to `200` under the caret, so the next digit fused with
 * the last (#3042). The array is written only while every entry is valid; an
 * invalid draft stays on screen with its message and the stored value is left
 * as it was.
 *
 * `value` changing from outside (another step, an undo) replaces the draft,
 * unless the new value is what the draft already parses to - that is this
 * field's own write coming back, and replacing the text then would undo the
 * spacing the user typed.
 */
function ArrayField({
	label,
	hint,
	itemType,
	value,
	onChange,
}: {
	label: string;
	hint: string | undefined;
	itemType: string | undefined;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const inputId = useId();
	const errorId = useId();
	const stored = Array.isArray(value) ? value : [];
	const storedText = stored.join(", ");
	const [draft, setDraft] = useState(storedText);
	const [seenText, setSeenText] = useState(storedText);

	if (storedText !== seenText) {
		setSeenText(storedText);
		const parsed = parseList(draft, itemType);
		if (parsed.invalid.length > 0 || parsed.items.join(", ") !== storedText) {
			setDraft(storedText);
		}
	}

	const { invalid } = parseList(draft, itemType);
	const error =
		invalid.length === 0
			? undefined
			: `${invalid.map((entry) => `"${entry}"`).join(", ")} ${
					invalid.length === 1 ? "is not a whole number" : "are not whole numbers"
				}. Not saved until fixed.`;

	return (
		<div className="space-y-1">
			<Label htmlFor={inputId} className="text-xs font-medium">
				{label}
			</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<Input
				size="sm"
				id={inputId}
				value={draft}
				placeholder="Comma-separated values"
				aria-invalid={error ? true : undefined}
				aria-describedby={error ? errorId : undefined}
				onChange={(e) => {
					setDraft(e.target.value);
					const parsed = parseList(e.target.value, itemType);
					if (parsed.invalid.length === 0) onChange(parsed.items);
				}}
			/>
			<FieldError id={errorId}>{error}</FieldError>
		</div>
	);
}

/** One row of a {@link StringMapField}; `id` is stable across edits so renaming a key keeps the row where it is. */
interface MapRow {
	id: number;
	key: string;
	value: string;
}

interface MapDraft {
	rows: MapRow[];
	nextId: number;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function draftFromRecord(record: Record<string, unknown>, firstId: number): MapDraft {
	const rows = Object.entries(record).map(([key, value], index) => ({
		id: firstId + index,
		key,
		value: asString(value),
	}));
	return { rows, nextId: firstId + rows.length };
}

/**
 * What a draft writes: only rows with a non-empty key, since an object cannot
 * spell a blank key. When two rows share a key the later row wins, which is
 * what `Object.fromEntries` does (and, unlike `record[key] = value`, it keeps
 * a key spelled `__proto__` as data).
 */
function recordFromRows(rows: MapRow[]): Record<string, string> {
	return Object.fromEntries(
		rows.filter((row) => row.key !== "").map((row) => [row.key, row.value])
	);
}

/**
 * A key/value editor for an `object` property that declares no `properties`
 * (#3047). Both sides are strings - `control.switch`'s `cases` maps a
 * variable's value to a folder member's name - and the stored value is a plain
 * object of string to string.
 *
 * The rows live in a draft of their own for the reason {@link ArrayField}'s
 * text does: a blank row, a half-typed key or a duplicate key cannot be spelled
 * in the stored object. Only the rows {@link recordFromRows} keeps are written,
 * and only when that changes the stored object, so adding a blank row saves
 * nothing. `value` changing from outside replaces the rows unless the draft
 * already writes that object - this field's own write coming back.
 */
function StringMapField({
	label,
	hint,
	value,
	onChange,
}: {
	label: string;
	hint: string | undefined;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const labelId = useId();
	const stored = asRecord(value);
	const storedText = JSON.stringify(stored);
	const [draft, setDraft] = useState(() => draftFromRecord(stored, 0));
	const [seenText, setSeenText] = useState(storedText);

	if (storedText !== seenText) {
		setSeenText(storedText);
		if (JSON.stringify(recordFromRows(draft.rows)) !== storedText) {
			setDraft(draftFromRecord(stored, draft.nextId));
		}
	}

	const update = (next: MapDraft) => {
		setDraft(next);
		const record = recordFromRows(next.rows);
		if (JSON.stringify(record) !== storedText) onChange(record);
	};
	const editRow = (id: number, patch: Partial<Pick<MapRow, "key" | "value">>) =>
		update({
			...draft,
			rows: draft.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
		});

	return (
		<div role="group" aria-labelledby={labelId} className="space-y-1">
			<span id={labelId} className="block text-xs font-medium">
				{label}
			</span>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			{draft.rows.map((row, index) => (
				<div key={row.id} className="flex items-center gap-1">
					<Input
						size="sm"
						value={row.key}
						placeholder="Key"
						aria-label={`Key ${index + 1}`}
						onChange={(e) => editRow(row.id, { key: e.target.value })}
					/>
					<Input
						size="sm"
						value={row.value}
						placeholder="Value"
						aria-label={`Value ${index + 1}`}
						onChange={(e) => editRow(row.id, { value: e.target.value })}
					/>
					<Button
						size="icon"
						variant="rowActionDestructive"
						className="shrink-0"
						aria-label={`Remove entry ${index + 1}`}
						onClick={() =>
							update({ ...draft, rows: draft.rows.filter((r) => r.id !== row.id) })
						}
					>
						<Trash2 className="size-icon-sm" data-icon-motion={ICON_MOTION.lid} />
					</Button>
				</div>
			))}
			<Button
				variant="outline"
				size="sm"
				onClick={() =>
					setDraft({
						rows: [...draft.rows, { id: draft.nextId, key: "", value: "" }],
						nextId: draft.nextId + 1,
					})
				}
			>
				<Plus className="size-icon-sm" />
				Add entry
			</Button>
		</div>
	);
}

/**
 * A field for a property whose schema declares no type, so it can legally hold
 * any JSON value - `assert.jsonpath`'s `expected` and a `metric.record`
 * condition's `value`. A plain text field stored `7` as the string "7", which
 * the engine's strict JSON compare never matches against a number (#3046).
 * Typed text is read as JSON and falls back to a string; the hint under the
 * field says which it became. Quote a value (`"7"`) to force a string.
 *
 * The text lives in a draft for the reason {@link ArrayField}'s does: the
 * stored value cannot spell an unfinished `{"a` or `-`. `value` changing from
 * outside replaces the draft unless the draft already reads as that value.
 * Nothing is written until the user types, so loading an element never
 * rewrites it.
 */
function JsonValueField({
	label,
	hint,
	value,
	error,
	onChange,
}: {
	label: string;
	hint: string | undefined;
	value: unknown;
	error: string | undefined;
	onChange: (value: unknown) => void;
}) {
	const inputId = useId();
	const kindId = useId();
	const errorId = useId();
	const storedText = jsonValueText(value);
	const [draft, setDraft] = useState(storedText);
	const [seenText, setSeenText] = useState(storedText);

	if (storedText !== seenText) {
		setSeenText(storedText);
		if (jsonValueText(parseJsonValue(draft)) !== storedText) setDraft(storedText);
	}

	const kind = jsonKindName(parseJsonValue(draft));

	return (
		<div className="space-y-1">
			<Label htmlFor={inputId} className="text-xs font-medium">
				{label}
			</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<Input
				size="sm"
				id={inputId}
				value={draft}
				className={error ? "border-destructive" : undefined}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy(error && errorId, kind && kindId)}
				onChange={(e) => {
					setDraft(e.target.value);
					onChange(parseJsonValue(e.target.value));
				}}
			/>
			<FieldError id={errorId}>{error}</FieldError>
			{kind && (
				<p id={kindId} className="text-xs text-muted-foreground">
					Stored as {kind}
				</p>
			)}
		</div>
	);
}

/** An `aria-describedby` value from the ids that are present, in reading order. */
function describedBy(...ids: Array<string | false | undefined>): string | undefined {
	return ids.filter(Boolean).join(" ") || undefined;
}

/** One property row, dispatched by the schema's declared type. */
function PropertyRow({
	name,
	property,
	value,
	errors,
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
	/** This level's messages; the row reads its own by `name`, and hands a nested object its slice. */
	errors: FieldErrors;
	onChange: (value: unknown) => void;
}) {
	property ??= {};
	const error = errors[name];
	const label = property.title ?? name;
	const hint = property.description;
	const unit = property["x-vayu-unit"];
	// Only the hand-rolled `Label` + `Input` pair below needs these - the
	// settings-row primitives (`ToggleRow`, `NumberSettingRow`,
	// `SelectSettingRow`) already associate their own label and message.
	const inputId = useId();
	const errorId = useId();

	if (property.type === "boolean") {
		return (
			<ToggleRow
				label={label}
				description={hint}
				checked={(value ?? property.default) === true}
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
				error={error}
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
				value={asString(value) || asString(property.default) || property.enum[0]}
				onChange={onChange}
				options={property.enum.map((option) => ({ value: option, label: option }))}
				error={error}
				compact
			/>
		);
	}

	if (property.type === "array") {
		return (
			<ArrayField
				label={label}
				hint={hint}
				itemType={property.items?.type}
				value={value}
				onChange={onChange}
			/>
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
					errors={errorsWithin(errors, name)}
					onChange={onChange}
				/>
			</fieldset>
		);
	}

	if (property.type === "object") {
		return <StringMapField label={label} hint={hint} value={value} onChange={onChange} />;
	}

	if (property.type === undefined) {
		return (
			<JsonValueField
				label={label}
				hint={hint}
				value={value}
				error={error}
				onChange={onChange}
			/>
		);
	}

	// A string property, and any declared type the branches above leave over.
	return (
		<div className="space-y-1">
			<Label htmlFor={inputId} className="text-xs font-medium">
				{label}
			</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
			<Input
				size="sm"
				id={inputId}
				value={asString(value)}
				className={error ? "border-destructive" : undefined}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy(error && errorId)}
				onChange={(e) => onChange(e.target.value)}
			/>
			<FieldError id={errorId}>{error}</FieldError>
		</div>
	);
}

export function GenericElementForm({
	schema,
	config,
	errors = NO_ERRORS,
	onChange,
}: GenericElementFormProps) {
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
				errors={errors}
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
						<ChevronRight className="size-icon-sm transition-transform" />
						Advanced
					</CollapsibleTrigger>
					<CollapsibleContent className="space-y-2 px-1 pt-1.5 pb-1">
						<PropertyRows
							names={advancedNames}
							properties={properties}
							config={config}
							errors={errors}
							onChange={onChange}
						/>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}

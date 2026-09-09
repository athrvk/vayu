/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ElementList (issue #1512)
 *
 * An ordered list of a request's or collection's own elements - extractors,
 * assertions, timers, controllers and scripts - each row a kind badge, an
 * optional name, an enable switch, reorder buttons, delete, and the kind's
 * form below it. The default form is generated from the kind's JSON Schema
 * (`GenericElementForm`); a bespoke override (`elementForms.ts`) replaces it
 * for a kind that needs one. The Add control is a searchable picker over the
 * catalogue, grouped by category (`element-categories.ts`), never a
 * hand-written list, so a kind the engine adds needs no change here.
 *
 * A primitive under `components/shared/`, so it takes no feature-module
 * context: the request builder's Elements tab and the collection detail's
 * both bind it to their own `elements` array and `updateField`-style setter.
 * Inherited (read-only) elements are a separate notice above this list
 * (`InheritedElementsNotice`), the same split the old script panels drew
 * between the editable script and the "runs before your own" chain card.
 *
 * `renderAboveForm` is the one host-supplied extension point (issue #1553):
 * a plain render function, so this file still depends on nothing but the
 * element itself - the host closes over whatever context it needs (variable
 * resolution, a data contract) and hands back a node, or nothing.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { ToggleRow } from "@/modules/settings/main/panels/SettingControls";
import { generateId } from "@/lib/id";
import { missingRequiredKeys } from "@/lib/elements";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores";
import type { ElementDef, ElementKindSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";
import { ELEMENT_FORM_OVERRIDES } from "./elementForms";
import { categoryLabel, categoryOrder, effectiveCategory } from "./element-categories";

/** The picker's "Recently used" group heading - the cap lives in `layout-store`. */
const RECENTLY_USED_HEADING = "Recently used";

export interface ElementListProps {
	elements: ElementDef[];
	onChange: (elements: ElementDef[]) => void;
	kinds: ElementKindSchema[];
	/** Shown when `elements` is empty, in place of the (otherwise empty) list. */
	emptyLabel?: string;
	/**
	 * Extra content rendered above one element's own form, keyed to that
	 * element - e.g. the "Names mentioned" row above a `script.*` element's
	 * editor. Return `null`/`undefined` for an element with nothing to add.
	 */
	renderAboveForm?: (element: ElementDef) => ReactNode;
}

function kindLabel(kind: string, kinds: ElementKindSchema[]): string {
	return kinds.find((k) => k.kind === kind)?.label ?? kind;
}

/**
 * Groups the addable catalogue by its display category, in family order
 * (`element-categories.ts`) - `control.transaction` folds into "Controller"
 * here rather than keeping its engine-side category as its own group.
 */
function groupedByCategory(kinds: ElementKindSchema[]): Map<string, ElementKindSchema[]> {
	const groups = new Map<string, ElementKindSchema[]>();
	// `inherit.disable` is consumed by the engine at compose time, never a row
	// a user adds by hand - it is written by the inheritance notice's disable
	// toggle instead.
	for (const kind of kinds.filter((k) => k.kind !== "inherit.disable")) {
		const category = effectiveCategory(kind.category);
		const list = groups.get(category) ?? [];
		list.push(kind);
		groups.set(category, list);
	}
	return new Map([...groups.entries()].sort(([a], [b]) => categoryOrder(a) - categoryOrder(b)));
}

/** `value` cmdk filters on - label, description and kind, so any of the three matches a search. */
function searchValue(kind: ElementKindSchema): string {
	return `${kind.label} ${kind.description} ${kind.kind}`;
}

/**
 * Plain case-insensitive substring matching, not cmdk's default fuzzy
 * scorer. The default treats a query as a scattered subsequence, so "regex"
 * fuzzy-matches unrelated prose too - `assert.jsonpath`'s "matches a regular
 * expression" contains r-e-g-e-x in order despite naming no regex kind. A
 * technical picker over exact kind names and descriptions wants "contains
 * this text", not "these letters appear somewhere, in this order".
 */
function commandFilter(value: string, search: string): number {
	return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
}

function ElementRow({
	element,
	kinds,
	isFirst,
	isLast,
	onUpdate,
	onRemove,
	onMove,
	renderAboveForm,
}: {
	element: ElementDef;
	kinds: ElementKindSchema[];
	isFirst: boolean;
	isLast: boolean;
	onUpdate: (element: ElementDef) => void;
	onRemove: () => void;
	onMove: (direction: -1 | 1) => void;
	renderAboveForm?: (element: ElementDef) => ReactNode;
}) {
	const schema = kinds.find((k) => k.kind === element.kind);
	const Bespoke = ELEMENT_FORM_OVERRIDES[element.kind];
	// Issue #1635: a fresh element's `config` is missing whatever its kind
	// requires until the user fills the form below, and saving in that state
	// 400s the whole request - `RequestBuilderProvider`/`ElementsTab` hold the
	// save back for exactly this, so the row has to say which field is why.
	const missingKeys = missingRequiredKeys(element, kinds);
	const missingLabels = missingKeys.map(
		(key) => schema?.configSchema.properties?.[key]?.title ?? key
	);

	return (
		<div
			className={cn(
				"space-y-3 rounded-md border border-rule surface-card p-3",
				!element.enabled && "opacity-60"
			)}
			data-element-row={element.kind}
		>
			<div className="flex items-center gap-2">
				<div className="flex flex-col">
					<Button
						variant="rowAction"
						size="icon"
						className="h-4 w-6"
						aria-label="Move element up"
						disabled={isFirst}
						onClick={() => onMove(-1)}
					>
						<ChevronUp className="h-3 w-3" />
					</Button>
					<Button
						variant="rowAction"
						size="icon"
						className="h-4 w-6"
						aria-label="Move element down"
						disabled={isLast}
						onClick={() => onMove(1)}
					>
						<ChevronDown className="h-3 w-3" />
					</Button>
				</div>
				<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium shrink-0">
					{kindLabel(element.kind, kinds)}
				</span>
				{missingLabels.length > 0 && (
					<span
						className="flex items-center gap-1.5 shrink-0 text-xs text-muted-foreground"
						data-element-incomplete
					>
						<span className="h-2 w-2 rounded-full bg-warning shrink-0" aria-hidden />
						Needs {missingLabels.join(", ")}
					</span>
				)}
				<Input
					value={element.name ?? ""}
					placeholder="Optional name"
					className="h-8 flex-1"
					onChange={(e) => onUpdate({ ...element, name: e.target.value || undefined })}
				/>
				<ToggleRow
					label="Enabled"
					ariaLabel={`Enable ${kindLabel(element.kind, kinds)}`}
					checked={element.enabled}
					onChange={(enabled) => onUpdate({ ...element, enabled })}
					className="shrink-0"
				/>
				<Button
					variant="rowActionDestructive"
					size="icon"
					aria-label={`Delete ${kindLabel(element.kind, kinds)}`}
					onClick={onRemove}
				>
					<Trash2 className="h-4 w-4" />
				</Button>
			</div>
			{renderAboveForm?.(element)}
			{Bespoke ? (
				<Bespoke
					kind={element.kind}
					config={element.config}
					onChange={(config) => onUpdate({ ...element, config })}
				/>
			) : schema ? (
				<GenericElementForm
					schema={schema.configSchema}
					config={element.config}
					onChange={(config) => onUpdate({ ...element, config })}
				/>
			) : (
				<p className="text-xs text-muted-foreground">
					This engine no longer registers kind &quot;{element.kind}&quot;.
				</p>
			)}
		</div>
	);
}

export function ElementList({
	elements,
	onChange,
	kinds,
	emptyLabel,
	renderAboveForm,
}: ElementListProps) {
	const groups = groupedByCategory(kinds);
	const [pickerOpen, setPickerOpen] = useState(false);
	const recentKindIds = useLayoutStore((s) => s.recentElementKinds);
	const addRecentElementKind = useLayoutStore((s) => s.addRecentElementKind);
	const recentKinds = recentKindIds
		.map((kind) => kinds.find((k) => k.kind === kind))
		.filter((k): k is ElementKindSchema => k !== undefined);

	function addElement(kind: ElementKindSchema) {
		const next: ElementDef = {
			id: `el_${generateId()}`,
			kind: kind.kind,
			enabled: true,
			config: {},
		};
		onChange([...elements, next]);
		addRecentElementKind(kind.kind);
		setPickerOpen(false);
	}

	function updateAt(index: number, element: ElementDef) {
		onChange(elements.map((e, i) => (i === index ? element : e)));
	}

	function removeAt(index: number) {
		onChange(elements.filter((_, i) => i !== index));
	}

	function moveAt(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= elements.length) return;
		const next = [...elements];
		[next[index], next[target]] = [next[target], next[index]];
		onChange(next);
	}

	return (
		<div className="space-y-3">
			{elements.length === 0 && emptyLabel && (
				<p className="text-sm text-muted-foreground">{emptyLabel}</p>
			)}
			{elements.map((element, index) => (
				<ElementRow
					key={element.id}
					element={element}
					kinds={kinds}
					isFirst={index === 0}
					isLast={index === elements.length - 1}
					onUpdate={(next) => updateAt(index, next)}
					onRemove={() => removeAt(index)}
					onMove={(direction) => moveAt(index, direction)}
					renderAboveForm={renderAboveForm}
				/>
			))}
			<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
				<PopoverTrigger asChild>
					<Button variant="outline" size="sm">
						<Plus className="h-4 w-4" />
						Add element
					</Button>
				</PopoverTrigger>
				{/* `border-0 bg-transparent shadow-none`: `Command` already paints its
				    own surface (`COMMAND_SURFACE` in `command.tsx`), so this popover
				    is a positioning box around it, not a second card - the shape
				    `ScriptSnippets.tsx` uses for the same `Command`, one surface deep. */}
				<PopoverContent
					align="start"
					className="w-96 border-0 bg-transparent p-0 shadow-none"
				>
					<Command filter={commandFilter}>
						<CommandInput placeholder="Search elements" />
						<CommandList className="max-h-80">
							<CommandEmpty>No element matches that.</CommandEmpty>
							{recentKinds.length > 0 && (
								<CommandGroup heading={RECENTLY_USED_HEADING}>
									{recentKinds.map((kind) => (
										<CommandItem
											key={`recent-${kind.kind}`}
											value={`recent ${searchValue(kind)}`}
											onSelect={() => addElement(kind)}
											className="flex-col items-start gap-0.5"
										>
											<span>{kind.label}</span>
											<TruncatedText className="w-full text-xs text-muted-foreground">
												{kind.description}
											</TruncatedText>
										</CommandItem>
									))}
								</CommandGroup>
							)}
							{[...groups.entries()].map(([category, categoryKinds]) => (
								<CommandGroup key={category} heading={categoryLabel(category)}>
									{categoryKinds.map((kind) => (
										<CommandItem
											key={kind.kind}
											value={searchValue(kind)}
											onSelect={() => addElement(kind)}
											className="flex-col items-start gap-0.5"
										>
											<span>{kind.label}</span>
											<TruncatedText className="w-full text-xs text-muted-foreground">
												{kind.description}
											</TruncatedText>
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}

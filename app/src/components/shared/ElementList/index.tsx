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
 * for a kind that needs one. The Add menu groups the catalogue by category,
 * never a hand-written list, so a kind the engine adds needs no change here.
 *
 * A primitive under `components/shared/`, so it takes no feature-module
 * context: the request builder's Elements tab and the collection detail's
 * both bind it to their own `elements` array and `updateField`-style setter.
 * Inherited (read-only) elements are a separate notice above this list
 * (`InheritedElementsNotice`), the same split the old script panels drew
 * between the editable script and the "runs before your own" chain card.
 */

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Input,
} from "@/components/ui";
import { ToggleRow } from "@/modules/settings/main/panels/SettingControls";
import { generateId } from "@/lib/id";
import { cn } from "@/lib/utils";
import type { ElementDef, ElementKindSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";
import { ELEMENT_FORM_OVERRIDES } from "./elementForms";

export interface ElementListProps {
	elements: ElementDef[];
	onChange: (elements: ElementDef[]) => void;
	kinds: ElementKindSchema[];
	/** Shown when `elements` is empty, in place of the (otherwise empty) list. */
	emptyLabel?: string;
}

function kindLabel(kind: string, kinds: ElementKindSchema[]): string {
	return kinds.find((k) => k.kind === kind)?.label ?? kind;
}

function groupedByCategory(kinds: ElementKindSchema[]): Map<string, ElementKindSchema[]> {
	const groups = new Map<string, ElementKindSchema[]>();
	// `inherit.disable` is consumed by the engine at compose time, never a row
	// a user adds by hand - it is written by the inheritance notice's disable
	// toggle instead.
	for (const kind of kinds.filter((k) => k.kind !== "inherit.disable")) {
		const list = groups.get(kind.category) ?? [];
		list.push(kind);
		groups.set(kind.category, list);
	}
	return groups;
}

function ElementRow({
	element,
	kinds,
	isFirst,
	isLast,
	onUpdate,
	onRemove,
	onMove,
}: {
	element: ElementDef;
	kinds: ElementKindSchema[];
	isFirst: boolean;
	isLast: boolean;
	onUpdate: (element: ElementDef) => void;
	onRemove: () => void;
	onMove: (direction: -1 | 1) => void;
}) {
	const schema = kinds.find((k) => k.kind === element.kind);
	const Bespoke = ELEMENT_FORM_OVERRIDES[element.kind];

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

export function ElementList({ elements, onChange, kinds, emptyLabel }: ElementListProps) {
	const groups = groupedByCategory(kinds);

	function addElement(kind: ElementKindSchema) {
		const next: ElementDef = {
			id: `el_${generateId()}`,
			kind: kind.kind,
			enabled: true,
			config: {},
		};
		onChange([...elements, next]);
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
				/>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						<Plus className="h-4 w-4" />
						Add element
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{[...groups.entries()].map(([category, categoryKinds], i) => (
						<DropdownMenuGroup key={category}>
							{i > 0 && <DropdownMenuSeparator />}
							<DropdownMenuLabel className="capitalize">{category}</DropdownMenuLabel>
							{categoryKinds.map((kind) => (
								<DropdownMenuItem
									key={kind.kind}
									onSelect={() => addElement(kind)}
									title={kind.description}
								>
									{kind.label}
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

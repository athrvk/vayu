/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ElementList (issue #1512, reworked into a card list by issue #1608)
 *
 * An ordered list of a request's or collection's own elements - extractors,
 * assertions, timers, controllers and scripts - each a collapsible card: an
 * icon, the element's name or its kind's label, a one-line summary of
 * its config while collapsed, an enable switch, and a `⋯` menu for rename,
 * move, duplicate and delete. The body, shown expanded, is the kind's form:
 * generated from its JSON Schema (`GenericElementForm`) unless a bespoke
 * override (`elementForms.ts`) replaces it. The Add control is a searchable
 * picker over the catalogue, grouped by category (`element-categories.ts`),
 * never a hand-written list, so a kind the engine adds needs no change here.
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

import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import {
	Button,
	Collapsible,
	CollapsibleContent,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	DeleteConfirmDialog,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Switch,
} from "@/components/ui";
import { RowActionsMenu, TruncatedText, type RowAction } from "@/components/shared";
import { generateId } from "@/lib/id";
import { isBlankScriptElement, missingRequiredKeys } from "@/lib/elements";
import { isCommitEnter } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores";
import type { ElementDef, ElementKindSchema } from "@/types";
import { GenericElementForm } from "./GenericElementForm";
import { ELEMENT_FORM_OVERRIDES } from "./elementForms";
import { categoryLabel, categoryOrder, effectiveCategory, kindIcon } from "./element-categories";
import { summarizeElement } from "./summarize-element";

/** The picker's "Recently used" group heading - the cap lives in `layout-store`. */
const RECENTLY_USED_HEADING = "Recently used";

/**
 * The empty state's quick-add chips (issue #1608), in the order they render.
 * `script.setup` is `collectionOnly` (#1499), so it only ever appears among
 * `kinds` - and therefore only ever renders as a chip - on the collection
 * tab; the request tab's `kinds` prop already excludes it.
 */
const QUICK_ADD_LABELS: Readonly<Record<string, string>> = {
	"extract.json": "Extract from JSON",
	"assert.status": "Assert status code",
	"script.pre": "Pre-request script",
	"script.setup": "Setup script",
};
const QUICK_ADD_KINDS = Object.keys(QUICK_ADD_LABELS);

export interface ElementListProps {
	elements: ElementDef[];
	onChange: (elements: ElementDef[]) => void;
	kinds: ElementKindSchema[];
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

/** The catalogue entries the empty state offers, in `QUICK_ADD_LABELS`' order. */
function quickAddCandidates(kinds: ElementKindSchema[]): ElementKindSchema[] {
	return QUICK_ADD_KINDS.map((kind) => kinds.find((k) => k.kind === kind)).filter(
		(k): k is ElementKindSchema => k !== undefined
	);
}

/**
 * A freshly added element's starting `config`. Every script kind's schema
 * requires the `script` key present - `config: {}` alone omits it, and the
 * engine validates a request's whole `elements` array on every save, so one
 * still-blank script element fails every subsequent save of the request,
 * not just its own (discovered live: quick-adding "Pre-request script" and
 * then touching anything else 400s with "Missing required property
 * 'script'"). An empty string satisfies the schema outright and is not a
 * placeholder - the engine already treats a blank script as a no-op
 * (`is_blank_script_element`), so `{ script: "" }` is a real, valid value
 * for "nothing written yet".
 */
function defaultConfigFor(kind: ElementKindSchema): Record<string, unknown> {
	return kind.kind.startsWith("script.") ? { script: "" } : {};
}

/**
 * An element with nothing configured yet - delete asks nothing for one of
 * these. A blank text field still leaves its key in `config` (`{path: ""}`),
 * so "nothing configured" means every value is empty rather than the object
 * itself being `{}`.
 */
function isElementBlank(element: ElementDef): boolean {
	if (isBlankScriptElement(element)) return true;
	return Object.values(element.config).every(
		(value) => value === undefined || value === null || value === ""
	);
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
	isNew,
	onUpdate,
	onRemove,
	onMove,
	onDuplicate,
	renderAboveForm,
}: {
	element: ElementDef;
	kinds: ElementKindSchema[];
	isFirst: boolean;
	isLast: boolean;
	/** Seeds this row's initial collapse state only - added or duplicated this session opens expanded. */
	isNew: boolean;
	onUpdate: (element: ElementDef) => void;
	onRemove: () => void;
	onMove: (direction: -1 | 1) => void;
	onDuplicate: () => void;
	renderAboveForm?: (element: ElementDef) => ReactNode;
}) {
	const schema = kinds.find((k) => k.kind === element.kind);
	const Bespoke = ELEMENT_FORM_OVERRIDES[element.kind];
	const label = kindLabel(element.kind, kinds);
	const title = element.name ?? label;
	const Icon = kindIcon(schema);
	const summary = summarizeElement(element, schema);
	// Issue #1635: a fresh element's `config` is missing whatever its kind
	// requires until the user fills the form below, and saving in that state
	// 400s the whole request - `RequestBuilderProvider`/`ElementsTab` hold the
	// save back for exactly this, so the row has to say which field is why.
	const missingKeys = missingRequiredKeys(element, kinds);
	const missingLabels = missingKeys.map(
		(key) => schema?.configSchema.properties?.[key]?.title ?? key
	);

	const [open, setOpen] = useState(isNew);
	const [renaming, setRenaming] = useState(false);
	const [nameDraft, setNameDraft] = useState(element.name ?? "");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// Flipped by `startRename`, consumed by `RowActionsMenu`'s
	// `onCloseAutoFocus` below - not a `setTimeout`. `onSelect` fires while
	// the `⋯` menu's own `FocusScope` is still actively trapping focus:
	// autofocusing this row's rename input in that same commit races the
	// trap and loses (a `focusin` outside a still-trapped scope is yanked
	// straight back into it, blurring the input the instant it claims
	// focus) - and, found live testing this feature, races the `aria-hidden`
	// Radix places on the rest of the page while the menu is open too, which
	// a guessed delay is not guaranteed to outlast. `onCloseAutoFocus` is the
	// exact signal Radix itself uses for "the closing content's cleanup has
	// finished, focus is about to move" - the same event this component
	// already claims to override the trigger-focus default with a
	// roving-tabindex tree's own row (`RowActionsMenu.tsx`).
	const pendingRenameRef = useRef(false);
	const startRename = () => {
		pendingRenameRef.current = true;
	};
	const commitRename = () => {
		const trimmed = nameDraft.trim();
		onUpdate({ ...element, name: trimmed.length > 0 ? trimmed : undefined });
		setRenaming(false);
	};

	const handleDelete = () => {
		if (isElementBlank(element)) onRemove();
		else setConfirmingDelete(true);
	};

	const actions: RowAction[] = [
		{ label: "Rename", icon: Pencil, onSelect: startRename },
		{ label: "Move up", icon: ArrowUp, onSelect: () => onMove(-1), disabled: isFirst },
		{ label: "Move down", icon: ArrowDown, onSelect: () => onMove(1), disabled: isLast },
		{ label: "Duplicate", icon: Copy, onSelect: onDuplicate },
		{ label: "Delete", icon: Trash2, onSelect: handleDelete, destructive: true },
	];

	const handleRowKeyDown = (e: React.KeyboardEvent) => {
		if (renaming || !e.altKey) return;
		if (e.key === "ArrowUp") {
			e.preventDefault();
			onMove(-1);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			onMove(1);
		}
	};

	return (
		<div
			className={cn(
				"rounded-md border border-rule surface-card",
				!element.enabled && "opacity-60"
			)}
			data-element-row={element.kind}
		>
			<Collapsible open={open} onOpenChange={setOpen}>
				<div className="flex h-8 items-center gap-1 px-2">
					<button
						type="button"
						aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
						onKeyDown={handleRowKeyDown}
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
					>
						<ChevronRight
							className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
						/>
					</button>
					{renaming ? (
						<Input
							autoFocus
							value={nameDraft}
							placeholder={label}
							className="h-6 flex-1"
							onChange={(e) => setNameDraft(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (isCommitEnter(e)) {
									e.preventDefault();
									commitRename();
								} else if (e.key === "Escape") {
									e.preventDefault();
									setRenaming(false);
								}
							}}
						/>
					) : (
						<button
							type="button"
							onClick={() => setOpen((o) => !o)}
							onKeyDown={handleRowKeyDown}
							className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left"
						>
							{Icon && (
								// eslint-disable-next-line react-hooks/static-components -- `Icon` is a lookup into `element-categories.ts`'s static KIND_ICONS/CATEGORY_ICONS maps (via kindIcon), the same shape as ELEMENT_FORM_OVERRIDES[element.kind] above; it is never freshly defined, only referentially stable components already loaded at module scope.
								<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							)}
							{/*
							 * `shrink-0` keeps a title at its natural width instead of
							 * ceding space in the flex distribution - the summary
							 * (`TruncatedText` below, `min-w-0 flex-1`) is the one meant
							 * to visually degrade first, so a short kind label like
							 * "Assert status code" always renders whole. `shrink-0`
							 * alone never truncates, though: a user-typed `name` has no
							 * length limit, and an unbounded box still renders at its
							 * full content width regardless of flex-shrink, pushing the
							 * summary, the enable switch and the `⋯` menu out of the row
							 * instead of yielding to them. `max-w-[55%]` is the cap
							 * `truncate` needs to actually engage for that case, without
							 * touching the common short-title case (`shrink-0` still
							 * wins there, well under the cap).
							 */}
							<span className="max-w-[55%] shrink-0 truncate text-sm">
								<span className="font-medium">{title}</span>
								{element.name && (
									<span className="ml-1.5 text-muted-foreground">{label}</span>
								)}
							</span>
							{/*
							 * A missing required field (issue #1635) takes the summary's
							 * spot rather than sharing the row with it - both being
							 * `min-w-0 flex-1` would split what little room is left
							 * after the title, and "why isn't this saving" outranks the
							 * config preview. Shown whether the card is open or
							 * collapsed: a list of collapsed cards is exactly where a
							 * user needs to spot which one is blocking the save
							 * without expanding each in turn.
							 */}
							{missingLabels.length > 0 ? (
								<span
									className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"
									data-element-incomplete
								>
									<span
										className="h-2 w-2 shrink-0 rounded-full bg-warning"
										aria-hidden
									/>
									<TruncatedText>{`Needs ${missingLabels.join(", ")}`}</TruncatedText>
								</span>
							) : (
								!open &&
								summary && (
									<TruncatedText className="min-w-0 flex-1 text-xs text-muted-foreground">
										{summary}
									</TruncatedText>
								)
							)}
						</button>
					)}
					<Switch
						checked={element.enabled}
						aria-label={`Enable ${label}`}
						className="shrink-0"
						onCheckedChange={(enabled) => onUpdate({ ...element, enabled })}
					/>
					<RowActionsMenu
						label={`More actions for ${label}`}
						actions={actions}
						onCloseAutoFocus={(e) => {
							if (!pendingRenameRef.current) return;
							pendingRenameRef.current = false;
							// Skip Radix's default (focus the trigger) - the rename
							// input is about to mount with `autoFocus` and claim focus
							// itself; landing it on the trigger first just to lose it
							// again a render later would flash focus across two controls.
							e.preventDefault();
							setNameDraft(element.name ?? "");
							setRenaming(true);
						}}
					/>
				</div>
				<CollapsibleContent className="space-y-2 border-t border-rule px-2 py-2">
					{renderAboveForm?.(element)}
					{Bespoke ? (
						<Bespoke
							id={element.id}
							kind={element.kind}
							config={element.config}
							description={schema?.description ?? ""}
							// The mode forms render their fields from the
							// catalogue like the generic one does; a script form
							// ignores it. Undefined only for a kind this engine
							// build no longer serves - a bespoke form still
							// renders there, as it always has.
							schema={schema?.configSchema}
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
				</CollapsibleContent>
			</Collapsible>
			<DeleteConfirmDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${title}?`}
				description={`This removes "${title}" and its configuration. This cannot be undone.`}
				onConfirm={() => {
					setConfirmingDelete(false);
					onRemove();
				}}
			/>
		</div>
	);
}

export function ElementList({ elements, onChange, kinds, renderAboveForm }: ElementListProps) {
	const groups = groupedByCategory(kinds);
	const [pickerOpen, setPickerOpen] = useState(false);
	const recentKindIds = useLayoutStore((s) => s.recentElementKinds);
	const addRecentElementKind = useLayoutStore((s) => s.addRecentElementKind);
	const copyScriptEditorHeight = useLayoutStore((s) => s.copyScriptEditorHeight);
	const recentKinds = recentKindIds
		.map((kind) => kinds.find((k) => k.kind === kind))
		.filter((k): k is ElementKindSchema => k !== undefined);
	// Seeds a just-added or just-duplicated row's initial collapse state only
	// (read once, in `ElementRow`'s own `useState` initializer) - the most
	// recent id is all that needs holding, since an older row already
	// captured its own answer into its own local state at its own mount.
	const [justAddedId, setJustAddedId] = useState<string | null>(null);

	function addElement(kind: ElementKindSchema) {
		const next: ElementDef = {
			id: `el_${generateId()}`,
			kind: kind.kind,
			enabled: true,
			config: defaultConfigFor(kind),
		};
		setJustAddedId(next.id);
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

	function duplicateAt(index: number) {
		const original = elements[index];
		const copy: ElementDef = {
			...original,
			id: `el_${generateId()}`,
			name: `${original.name ?? kindLabel(original.kind, kinds)} copy`,
		};
		setJustAddedId(copy.id);
		// A duplicated script element starts at its source's own editor height,
		// not the shared default (issue #1608) - a no-op for every other kind,
		// since only a script element ever has an entry in `scriptEditorHeights`.
		copyScriptEditorHeight(original.id, copy.id);
		onChange([...elements.slice(0, index + 1), copy, ...elements.slice(index + 1)]);
	}

	return (
		<div className="space-y-2">
			{elements.length === 0 ? (
				<div className="enter-fade space-y-2 rounded-md border border-dashed border-rule p-3 text-center">
					<p className="text-sm text-muted-foreground">
						No elements yet. Add one from the menu below, or start with:
					</p>
					<div className="flex flex-wrap justify-center gap-2">
						{quickAddCandidates(kinds).map((kind) => (
							<Button
								key={kind.kind}
								type="button"
								variant="outline"
								size="sm"
								className="rounded-full"
								onClick={() => addElement(kind)}
							>
								{QUICK_ADD_LABELS[kind.kind]}
							</Button>
						))}
					</div>
				</div>
			) : (
				elements.map((element, index) => (
					<ElementRow
						key={element.id}
						element={element}
						kinds={kinds}
						isFirst={index === 0}
						isLast={index === elements.length - 1}
						isNew={element.id === justAddedId}
						onUpdate={(next) => updateAt(index, next)}
						onRemove={() => removeAt(index)}
						onMove={(direction) => moveAt(index, direction)}
						onDuplicate={() => duplicateAt(index)}
						renderAboveForm={renderAboveForm}
					/>
				))
			)}
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
									{recentKinds.map((kind) => {
										const Icon = kindIcon(kind);
										return (
											<CommandItem
												key={`recent-${kind.kind}`}
												value={`recent ${searchValue(kind)}`}
												onSelect={() => addElement(kind)}
												className="flex-col items-start gap-0.5"
											>
												<span className="flex items-center gap-1.5">
													{Icon && (
														<Icon className="text-muted-foreground" />
													)}
													<span>{kind.label}</span>
												</span>
												<TruncatedText className="w-full text-xs text-muted-foreground">
													{kind.description}
												</TruncatedText>
											</CommandItem>
										);
									})}
								</CommandGroup>
							)}
							{[...groups.entries()].map(([category, categoryKinds]) => (
								<CommandGroup key={category} heading={categoryLabel(category)}>
									{categoryKinds.map((kind) => {
										const Icon = kindIcon(kind);
										return (
											<CommandItem
												key={kind.kind}
												value={searchValue(kind)}
												onSelect={() => addElement(kind)}
												className="flex-col items-start gap-0.5"
											>
												<span className="flex items-center gap-1.5">
													{Icon && (
														<Icon className="text-muted-foreground" />
													)}
													<span>{kind.label}</span>
												</span>
												<TruncatedText className="w-full text-xs text-muted-foreground">
													{kind.description}
												</TruncatedText>
											</CommandItem>
										);
									})}
								</CommandGroup>
							))}
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}

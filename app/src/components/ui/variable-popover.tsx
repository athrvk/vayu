/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What opens when you click a `{{token}}`, and the switch between its states:
 *
 *   resolved   the value, editable (`ResolvedValueEditor`), with the environment
 *              or collection it came from and every other definition that lost
 *   undefined  a value field and a scope to create it in (`CreateVariableForm`)
 *   read-only  the value, when there is no way to change it from here
 *
 * **A bound data row outranks all of them** (#1007, #1064): while one is picked its column answers
 * a bare name above every scope, so the popover names the row as the origin and strikes the
 * definitions beneath. **Not resolving is not being undefined** (#1083): a name whose every
 * definition is off arrives unresolved, so the definitions are listed under every state. **A create
 * writes only into a scope the caller says is writable**: `updateVariable` silently no-ops without
 * an active target (no environment, no collection), so any other scope is a Create that does
 * nothing. The edit buffer, reveal flag, picked scope, create form's secret flag and the
 * Escape/auto-save flow stay here, not in the children `PopoverContent` unmounts on close: the
 * close path saves or discards the buffer and re-masks the secret, and a picked scope or secret
 * flag survives a re-open.
 */

import { useState, useRef, useMemo, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Badge } from "./badge";
import { CreateVariableForm } from "./create-variable-form";
import { ResolvedValueEditor, SECRET_MASK } from "./resolved-value-editor";
import { VariableScopeBadge, type VariableScope } from "./variable-scope-badge";
import { VARIABLE_SCOPE_CONFIG, VARIABLE_SCOPE_DOT } from "@/constants/variables";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import { isDataVariableName } from "@/lib/variable-resolution";
import { MENU_TRIGGERED_CLICK_DETAIL } from "@/lib/context-menu";
import { KeyRound } from "lucide-react";
import type { ResolvedVariable, VariableCreateOptions, VariableOrigin } from "@/types";
import { Eyebrow } from "./eyebrow";
import { Callout } from "@/components/shared/Callout";

// `ResolvedVariable` re-exported as `VariableInfo`, the name older importers use.
export type { ResolvedVariable as VariableInfo };

/** Highest precedence first - the scope a new variable most likely belongs in. */
const SCOPE_PREFERENCE: VariableScope[] = ["environment", "collection", "global"];

/**
 * What a `"row"` origin calls itself: a row has no `sourceName`, being the one row picked, not
 * something someone named.
 */
const BOUND_ROW_LABEL = "Bound row";

/**
 * Every chip beside the name (a `Badge variant="chip"`, coloured per state), shared so a shape fix
 * reaches all, pinned to the scope badge's 18px so no chip drifts on gaining an icon.
 */
const NAME_CHIP = "h-[18px] px-1.5 py-0 text-micro leading-none";

/**
 * The bare spelling's sentence, deliberately not the `data.*` one: `{{data.email}}` is disjoint
 * from the scopes, so "defining one would change nothing" holds for it, while defining a bare
 * `{{email}}` answers every send carrying no row and only loses to a picked one. Saying "nothing"
 * would be false.
 */
const BOUND_ROW_NOTE =
	"While a row is picked, its column answers this name. The definition above still resolves on a send that carries no row.";

/**
 * The same note when every definition under the row is off. `BOUND_ROW_NOTE`'s "still resolves on a
 * send that carries no row" is what an off definition does not do, so the row would reassure about
 * a fallback that does not exist. Drop the row and the token goes red, which is worth saying
 * (#1083).
 */
const BOUND_ROW_NOTE_ALL_OFF =
	"While a row is picked, its column answers this name. Every definition below is switched off, so a send that carries no row resolves nothing.";

export interface VariablePopoverProps {
	name: string;
	/** The value and scope, or null. */
	varInfo: ResolvedVariable | null;
	resolved: boolean;
	/**
	 * A sentence qualifying the answer below it, for a stored value a send will not carry (a name a
	 * pre-request script sets, #2741); the value stays editable, being the definition.
	 */
	note?: string;
	/**
	 * Required for editing. An edit of the resolved definition passes its `sourceId` so the write
	 * lands there; a create passes none (#3683) and always carries `options`, which an edit never
	 * does.
	 */
	onValueChange?: (
		name: string,
		value: string,
		scope: VariableScope,
		sourceId?: string,
		options?: VariableCreateOptions
	) => void;
	/** `manual` shows Save/Cancel; `auto` saves on close. */
	saveMode?: "manual" | "auto";
	disabled?: boolean;
	trigger: React.ReactNode;
	triggerClassName?: string;
	/**
	 * Every definition of the name, lowest precedence first, disabled ones included; drawn whenever
	 * it holds one the popover is not already showing, when "why is this the value?" has a
	 * non-obvious answer, resolved or not (#1083).
	 */
	origins?: VariableOrigin[];
	/**
	 * Scopes a create can be written to; empty or omitted, an undefined variable explains where to
	 * define it instead, as this popover could put it nowhere.
	 */
	writableScopes?: VariableScope[];
	/**
	 * The trigger's place in a host's roving tab order (#1215): `VariableInput` paints a strip of
	 * tokens over one field and passes `-1` to all but one, so the strip is one Tab stop. Defaults
	 * to `0`, an ordinary stop; `disabled` still wins.
	 */
	tabIndex?: number;
	/**
	 * Open on mount, for a host that already decided to open it (#1220): a token in Monaco has no
	 * DOM node to click, so the editor mounts this already open over the token's rectangle, a fresh
	 * instance per open, as there is no persistent trigger to drive a controlled `open`.
	 */
	defaultOpen?: boolean;
	/**
	 * Drives `isOpen` from outside, instead of `defaultOpen`'s once-at-mount value (#1220), for a
	 * host with a real, persistent trigger (`EditableVariable`'s token) that opens the *same*
	 * instance for more than one reason (a hover without focus, a chord with it). A fresh instance
	 * per open, as Monaco's anchor uses, would replace a hoverable token's live node under the
	 * pointer, which the browser reports as a leave-then-enter of two elements, retriggering the
	 * hover logic in a flicker loop. Undefined, `isOpen` falls back to `defaultOpen`'s local state.
	 */
	open?: boolean;
	/**
	 * Told on every open and close, after this component's own save on close: a host that
	 * positioned the trigger itself unmounts and restores focus, or, with `open`, notices a request
	 * to open the instance it owns.
	 */
	onOpenChange?: (open: boolean) => void;
	/**
	 * Move focus into the popover on open. Off by default, as `VariableInput` needs: its tokens sit
	 * over a live `<input>`, and taking focus on a click mid-URL would take the caret. An editor's
	 * token needs the opposite: it opens by chord, and a keyboard user must reach what opened.
	 */
	focusOnOpen?: boolean;
	/**
	 * Forwarded onto the trigger span (#1220): a host running hover timers off this token needs the
	 * listener on the element that *is* the token, not a wrapper, as `VariableInput/`'s font and
	 * layout guards read `[data-variable-token] span` expecting this trigger first.
	 */
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
	/**
	 * Told when the pointer enters or leaves the rendered *content* (#1220), as ordinary props on
	 * `PopoverContent`: a host's leave-grace timer for a hover-opened popover cancels a pending
	 * close when the pointer reaches the content and restarts one when it leaves. `PopoverContent`
	 * is in this JSX, so these fire in the commit that creates its node, with no mount race of the
	 * kind a host reaching for the node from outside (`querySelector` after `setTimeout`,
	 * document-level `mouseover` delegation) would face.
	 */
	onContentMouseEnter?: () => void;
	onContentMouseLeave?: () => void;
}

export function VariablePopover({
	name,
	varInfo,
	resolved,
	note,
	onValueChange,
	saveMode = "auto",
	disabled = false,
	trigger,
	triggerClassName,
	origins,
	writableScopes,
	tabIndex = 0,
	defaultOpen = false,
	open,
	onOpenChange,
	focusOnOpen = false,
	onMouseEnter,
	onMouseLeave,
	onContentMouseEnter,
	onContentMouseLeave,
}: VariablePopoverProps) {
	/*
	 * Uncontrolled unless a host passes `open`: `isOpen` then tracks the prop, and `setIsOpen` is a
	 * no-op, the host's state driving the next render via `onOpenChange` rather than a second
	 * write.
	 */
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const isOpen = open ?? uncontrolledOpen;
	const setIsOpen = (next: boolean) => {
		if (open === undefined) setUncontrolledOpen(next);
	};
	const [editValue, setEditValue] = useState(varInfo?.value || "");
	const [isSecretRevealed, setIsSecretRevealed] = useState(false);
	const openValueRef = useRef(varInfo?.value || "");
	const pendingCancelRef = useRef(false);

	/**
	 * Seeds the edit buffer on the transition into open, from this trigger or a controlled `open` a
	 * host flipped (a hover never touching the trigger). On the edge (`isOpen` true, `wasOpen`
	 * false), not every `isOpen`/`varInfo` change: re-seeding on a fresh `varInfo` object reset
	 * `editValue` under a user mid-type. The edge guard is what lets one effect serve every path.
	 */
	const wasOpenRef = useRef(isOpen);
	useEffect(() => {
		if (isOpen && !wasOpenRef.current && varInfo) {
			openValueRef.current = varInfo.value;
			setEditValue(varInfo.value);
		}
		wasOpenRef.current = isOpen;
	}, [isOpen, varInfo]);

	const openPopover = () => {
		setIsOpen(true);
		onOpenChange?.(true);
	};

	const closePopover = () => {
		setIsSecretRevealed(false);
		setIsOpen(false);
		onOpenChange?.(false);
	};

	const canEdit = !!onValueChange && !!varInfo && resolved && !disabled;

	/*
	 * A `data.*` name is not an undefined variable: it addresses the reserved data namespace
	 * (#402), disjoint from the scopes, so a variable of that name could never answer for the
	 * column (both resolvers skip the scopes for it) and the create offer would be a dead end.
	 * Guarded here, not only at the painter, as any caller rendering a token reaches this popover.
	 */
	const isDataName = isDataVariableName(name);

	/**
	 * The bound row's answer for this name, if any (#1064), read off `origins`, not its own prop:
	 * the resolver ranks the row against the definitions it beats, and a second channel is how two
	 * winners come to disagree.
	 */
	const boundRowOrigin = origins?.find((o) => o.scope === "row");

	/**
	 * This name's switched-off definitions (#1083). A name resolves exactly when some definition is
	 * enabled, so an unresolved name with definitions has every one off. Filtered on `enabled`, not
	 * inferred from `resolved`: the two are separate props, and a list describing itself cannot be
	 * wrong about what it holds.
	 */
	const switchedOffDefinitions = (origins ?? []).filter((o) => o.scope !== "row" && !o.enabled);

	// Creating is only offered where a write would land somewhere.
	const creatableScopes = useMemo(
		() => SCOPE_PREFERENCE.filter((s) => writableScopes?.includes(s)),
		[writableScopes]
	);
	const canCreate =
		!resolved && !isDataName && !!onValueChange && !disabled && creatableScopes.length > 0;
	// Here, not in the form, which unmounts on close: a picked scope survives a re-open.
	const [createScope, setCreateScope] = useState<VariableScope | null>(null);
	// Beside the value it masks: reopening shows the typed value, which must not return in the
	// clear.
	const [createSecret, setCreateSecret] = useState(false);

	/*
	 * The create form shares `editValue`, which the seed effect filled from the definition. When it
	 * goes (an environment switch, a deleted variable) the buffer would carry the old value, a
	 * secret's included, into the create form's plain field (#3719). Cleared on the set-to-unset
	 * edge only: a `varInfo` staying set must never reset a value mid-edit, whatever its identity
	 * does.
	 */
	const hadDefinitionRef = useRef(!!varInfo);
	useEffect(() => {
		if (!varInfo && hadDefinitionRef.current) {
			openValueRef.current = "";
			setEditValue("");
			setCreateSecret(false);
		}
		hadDefinitionRef.current = !!varInfo;
	}, [varInfo]);

	const handleOpenChange = (open: boolean) => {
		if (open) {
			openPopover();
		} else {
			// Closing: auto-save in auto mode when the value changed, unless cancelled.
			if (!pendingCancelRef.current && saveMode === "auto" && onValueChange && varInfo) {
				if (editValue !== openValueRef.current) {
					onValueChange(name, editValue, varInfo.scope, varInfo.sourceId);
				}
			}
			pendingCancelRef.current = false;
			closePopover();
		}
	};

	const handleSave = () => {
		if (onValueChange && varInfo) {
			onValueChange(name, editValue, varInfo.scope, varInfo.sourceId);
		}
		closePopover();
	};

	const handleCancel = () => {
		if (varInfo) {
			setEditValue(varInfo.value);
		}
		closePopover();
	};

	const handleCreate = (scope: VariableScope) => {
		if (!onValueChange) return;
		onValueChange(name, editValue, scope, undefined, { secret: createSecret });
		closePopover();
	};

	/*
	 * `e.preventDefault()` on both keys. Closing hands focus back to the host (for a Monaco token,
	 * `editor.focus()`, synchronously via `onClose` in `useEditorVariableTokens.ts`'s `open`), and
	 * an unprevented key applies its default to whatever is focused when the browser gets to it:
	 * Enter's newline landed in the refocused Monaco, splitting the line as the popover closed.
	 */
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (saveMode === "manual") {
			if (isCommitEnter(e)) {
				e.preventDefault();
				handleSave();
			} else if (e.key === "Escape") {
				e.preventDefault();
				handleCancel();
			}
		} else {
			// Auto mode: Enter saves, Escape cancels.
			if (isCommitEnter(e)) {
				e.preventDefault();
				handleOpenChange(false);
			} else if (e.key === "Escape") {
				e.preventDefault();
				// Marked cancelled before Radix fires its own onOpenChange for Escape.
				pendingCancelRef.current = true;
				closePopover();
			}
		}
	};

	const isSecret = !!varInfo?.secret;

	/**
	 * The trigger is a `<span>`: a token sits inline mid-URL or mid-header and must not break the
	 * flow. Radix's `asChild` clones its click handler and `aria-*` onto it but does not make a
	 * span focusable, which left every token mouse-only. `role="button"`, `tabIndex` and
	 * Enter/Space give what a `<button>` would, without its block layout. `disabled` tokens leave
	 * the tab order rather than sitting in it doing nothing.
	 */
	const triggerElement = (
		<span
			role="button"
			tabIndex={disabled ? -1 : tabIndex}
			className={cn("inline", triggerClassName)}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			onClick={(e) => {
				if (disabled) return;
				/*
				 * A click from the "Edit variable" menu command (`lib/context-menu.ts`) carries
				 * this sentinel instead of a click count: an explicit request to open. An ordinary
				 * pointer click places a caret in the text beneath (`VariableInput/index.tsx`) and
				 * opens nothing.
				 */
				if (e.detail !== MENU_TRIGGERED_CLICK_DETAIL) {
					/*
					 * `PopoverTrigger asChild` composes Radix's click-to-toggle with this handler
					 * (`composeEventHandlers`), which runs unless the default was prevented, so an
					 * ordinary click would open through Radix regardless.
					 */
					e.preventDefault();
					return;
				}
				e.stopPropagation(); // Prevent input blur
				if (!isOpen) openPopover();
			}}
			onKeyDown={(e) => {
				if (disabled) return;
				if (e.key === "Enter" || e.key === " ") {
					// Space especially: the token is usually in a text input, where it would type a
					// space.
					e.preventDefault();
					e.stopPropagation();
					openPopover();
				}
			}}
		>
			{trigger}
		</span>
	);

	return (
		<Popover open={isOpen} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
			<PopoverContent
				// `w-sm` (24rem), not `w-96`: name, value and source are a text measure, and `w-96`
				// rides `--spacing` (288px at Default, not 384px).
				className="w-sm max-w-[calc(100vw-2rem)] p-2.5"
				aria-label={`Variable ${name}`}
				align="start"
				side="bottom"
				onClick={(e) => e.stopPropagation()}
				onMouseEnter={onContentMouseEnter}
				onMouseLeave={onContentMouseLeave}
				onPointerDownOutside={(e) => {
					if (saveMode === "manual") {
						e.preventDefault();
					}
				}}
				onEscapeKeyDown={() => {
					/*
					 * Radix's `DismissableLayer` closes on Escape through a document-level capture
					 * listener running before the `<Input>`'s bubble handler, so a flag set there
					 * arrived after `handleOpenChange`'s auto-save check had committed what was
					 * typed. Set here, in the callback Radix invokes in that dismissal, it lands
					 * first however the handlers race.
					 */
					pendingCancelRef.current = true;
				}}
				onOpenAutoFocus={(e) => {
					// See `focusOnOpen`: a token over a live input keeps the caret; one opened by
					// chord must be reachable.
					if (!focusOnOpen) e.preventDefault();
				}}
			>
				<div className="flex flex-col gap-2">
					{/*
					 * Name, secret mark and origin. `items-center`, not `items-baseline`: baseline
					 * lines up text baselines of boxes whose contents differ, and the Secret chip
					 * has an icon the scope badge lacks, so they sat at different heights. Both
					 * chips are pinned to 18px so neither drifts when one gains content.
					 */}
					<div className="flex flex-row items-center justify-between gap-2">
						<span className="font-mono text-sm font-semibold truncate">{name}</span>
						<div className="flex shrink-0 items-center gap-1.5">
							{/*
							 * The secret mark sits beside the scope, not on a labelled row: like
							 * the scope, a property of the variable, not a section.
							 */}
							{isSecret && (
								<Badge
									variant="chip"
									title="Secret - hidden until revealed"
									className={cn(
										NAME_CHIP,
										"gap-1 border-warning-text/40 text-warning-text"
									)}
								>
									<KeyRound className="size-icon-sm" />
									Secret
								</Badge>
							)}
							{varInfo ? (
								<VariableScopeBadge
									scope={varInfo.scope}
									variant="full"
									className="h-[18px] leading-none"
								/>
							) : isDataName ? (
								<Badge
									variant="chip"
									className={cn(
										NAME_CHIP,
										"border-muted-foreground/40 text-muted-foreground"
									)}
								>
									data
								</Badge>
							) : boundRowOrigin ? (
								/*
								 * Answered, so not "undefined", and in the accent, not the
								 * destructive red, which means a token reaching the server with its
								 * braces on; the row carries the column.
								 */
								<Badge
									variant="chip"
									className={cn(NAME_CHIP, "border-primary/40 text-primary")}
								>
									row
								</Badge>
							) : (
								<Badge
									variant="chip"
									className={cn(
										NAME_CHIP,
										"border-destructive-text/40 text-destructive-text"
									)}
								>
									undefined
								</Badge>
							)}
						</div>
					</div>

					{note && (
						<p className="text-label leading-snug text-muted-foreground">{note}</p>
					)}

					{resolved && varInfo ? (
						<>
							{/*
							 * Where the value lives, on its own line (#1320): sharing the footer
							 * with the keycaps truncated "Shopify QA - expiring tokens" to "Shopify
							 * QA - expiring…", clipping the fact the popover was opened for. The
							 * tooltips' answer (#1195, `docs/design-system/color-schemes.md`), one
							 * primitive over: the source stacks, full width. Two lines at most, the
							 * whole name on `title`. A definition with no source name (a global)
							 * prints its scope word, so the line is always there and the card keeps
							 * its height across scopes.
							 */}
							<p
								className="line-clamp-2 text-label leading-snug text-muted-foreground"
								title={varInfo.sourceName || undefined}
							>
								in{" "}
								<span className="font-medium text-foreground">
									{varInfo.sourceName ||
										VARIABLE_SCOPE_CONFIG[varInfo.scope].full}
								</span>
							</p>

							<ResolvedValueEditor
								name={name}
								varInfo={varInfo}
								canEdit={canEdit}
								editValue={editValue}
								onEditValueChange={setEditValue}
								onKeyDown={handleKeyDown}
								saveMode={saveMode}
								revealed={isSecretRevealed}
								onRevealChange={setIsSecretRevealed}
								autoFocus={focusOnOpen}
								onSave={handleSave}
								onCancel={handleCancel}
							/>
						</>
					) : canCreate ? (
						<CreateVariableForm
							name={name}
							scopes={creatableScopes}
							selectedScope={createScope}
							onSelectedScopeChange={setCreateScope}
							secret={createSecret}
							onSecretChange={setCreateSecret}
							value={editValue}
							onValueChange={setEditValue}
							onCreate={handleCreate}
							autoFocus={focusOnOpen}
							boundRowOrigin={boundRowOrigin}
							switchedOffCount={switchedOffDefinitions.length}
						/>
					) : isDataName ? (
						<div className="text-sm text-muted-foreground">
							Bound per iteration by the run&rsquo;s data file. Not a variable -
							defining one with this name would change nothing.
						</div>
					) : boundRowOrigin ? (
						/*
						 * Undefined everywhere, but the picked row carries the column, so the send
						 * resolves it. "Not defined in any scope" in destructive red is what this
						 * must not say: the red means a token reaching the server with its braces
						 * on.
						 */
						<div className="text-sm text-muted-foreground">
							Answered by the bound data row&rsquo;s{" "}
							<span className="font-mono">{name}</span> column, not by a variable.
							Defining one would answer a send that carries no row.
						</div>
					) : switchedOffDefinitions.length > 0 ? (
						/*
						 * Defined and still red: the token does not resolve, so the red is honest.
						 * "Not defined" above a list showing where it is defined, with an `off`
						 * badge, would send the reader to do what they already did (#1083).
						 */
						<Callout severity="blocking">
							Defined, but every definition is switched off, so this token does not
							resolve and is sent as literal text.
						</Callout>
					) : (
						<Callout severity="blocking">
							Not defined in any scope, so this token is sent as literal text. Define
							it in globals, an environment, or a collection.
						</Callout>
					)}
					{/*
					 * Outside the branch chain: "where could this have come from" is the same
					 * question in every state, and a name whose only definition is off, the state
					 * most likely to raise it, is one that could not ask it (#1083). `data.*` is
					 * excluded: the namespace is disjoint from the scopes, so listing a definition
					 * of that name would say it might answer.
					 */}
					{!isDataName && <ShadowedBy origins={origins} />}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * One line of the "where could this have come from" list, shared by the winner and the definitions
 * beneath so they cannot drift: the strike-through, the only difference, is the message (a struck
 * value the send will not use).
 */
function OriginRow({ origin, beaten }: { origin: VariableOrigin; beaten: boolean }) {
	// A disabled definition competes with nothing, so no colour. The row takes the accent, not a
	// fourth scope colour: it is no place a variable lives but the live answer, which the app
	// paints in the accent.
	const dot = !origin.enabled
		? "bg-subtle-foreground"
		: origin.scope === "row"
			? "bg-primary"
			: VARIABLE_SCOPE_DOT[origin.scope];
	const label =
		origin.scope === "row" ? BOUND_ROW_LABEL : VARIABLE_SCOPE_CONFIG[origin.scope].full;

	return (
		<div className="flex items-center gap-1.5 text-micro text-muted-foreground">
			<span className={cn("size-[5px] shrink-0 rounded-full", dot)} />
			<span className="shrink-0">{origin.sourceName ?? label}</span>
			<span className={cn("truncate font-mono", beaten && "line-through opacity-60")}>
				{origin.secret ? SECRET_MASK : origin.value || "empty"}
			</span>
			{!origin.enabled && (
				<span className="ml-auto shrink-0 rounded-md border border-rule px-1 not-italic">
					off
				</span>
			)}
		</div>
	);
}

/**
 * Where the value comes from, and what it beat. Drawn when the list holds a definition the popover
 * is not already showing, asking "is any of them not the winner" rather than counting entries: a
 * name whose one definition wins has nothing to add (the field *is* it), while a name whose only
 * definition is off must still list it (#1083). Three row states: a definition loses by precedence
 * *or* by being off, the more common surprise (your value skipped, not missing), and a list showing
 * only shadowing would stay silent on it. A bound row's cell is listed above all, unstruck (#1064),
 * or the popover explains a value the send will not use: the editable field is the *variable*,
 * still what you can change, while the row answers the name until the pick is dropped.
 */
function ShadowedBy({ origins }: { origins?: VariableOrigin[] }) {
	if (!origins || origins.length === 0) return null;

	// Highest precedence first: reading down is reading the order the resolver rejected them in.
	const ranked = [...origins].reverse();
	const row = ranked.find((o) => o.scope === "row");
	const others = ranked.filter((o) => !o.winner && o.scope !== "row");
	if (others.length === 0) return null;

	return (
		<div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
			{row && (
				<>
					<Eyebrow size="xs">bound data row</Eyebrow>
					<OriginRow origin={row} beaten={false} />
				</>
			)}
			{/*
			 * "also defined" even with a row above, not "shadowed": the list holds definitions lost
			 * by precedence *and* switched off, and an off one is shadowed by nothing. The row
			 * block says which answer wins.
			 */}
			<Eyebrow size="xs">also defined</Eyebrow>
			{others.map((o, i) => (
				<OriginRow key={`${o.scope}-${o.sourceId ?? "global"}-${i}`} origin={o} beaten />
			))}
			{row && (
				<p className="text-micro text-muted-foreground">
					{others.some((o) => o.enabled) ? BOUND_ROW_NOTE : BOUND_ROW_NOTE_ALL_OFF}
				</p>
			)}
		</div>
	);
}

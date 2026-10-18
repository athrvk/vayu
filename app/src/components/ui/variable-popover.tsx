/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variable Popover
 *
 * What opens when you click a `{{token}}`, and the switch between its states:
 *
 *   resolved   the value, editable (`ResolvedValueEditor`), with the environment
 *              or collection it came from and every other definition that lost
 *   undefined  a value field and a scope to create it in (`CreateVariableForm`)
 *   read-only  the value, when there is no way to change it from here
 *
 * **A bound data row outranks all of them** (#1007, #1064). While one is picked
 * its column answers a bare name above every scope, so the popover names the row
 * as the origin and strikes the definitions beneath it.
 *
 * **Not resolving is not the same as not being defined** (#1083). A name whose
 * every definition is switched off arrives unresolved, so the list of
 * definitions is drawn under every state rather than under the resolved one
 * alone.
 *
 * **A create writes only into a scope the caller says is writable**:
 * `updateVariable` silently no-ops when the target scope has no active target
 * (no environment selected, no collection), so offering any other scope is a
 * Create button that does nothing.
 *
 * The edit buffer, the reveal flag, the picked scope and the Escape/auto-save
 * flow stay here rather than in the two children, which `PopoverContent`
 * unmounts on close: the close path saves or discards the buffer and re-masks
 * the secret, and a picked scope survives a re-open.
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
import type { ResolvedVariable, VariableOrigin } from "@/types";
import { Eyebrow } from "./eyebrow";
import { Callout } from "@/components/shared/Callout";

// Re-export ResolvedVariable as VariableInfo for backward compatibility
export type { ResolvedVariable as VariableInfo };

/** Highest precedence first - the scope a new variable most likely belongs in. */
const SCOPE_PREFERENCE: VariableScope[] = ["environment", "collection", "global"];

/**
 * What a `"row"` origin calls itself. A row has no `sourceName` to give - it is
 * the one row currently picked, not a file or an environment someone named.
 */
const BOUND_ROW_LABEL = "Bound row";

/**
 * The shape of every chip beside the name (a `Badge variant="chip"` with its
 * colour added per state). Shared so a shape fix reaches all of them; pinned to
 * 18px, the scope badge's height, so no chip drifts when it gains an icon.
 */
const NAME_CHIP = "h-[18px] px-1.5 py-0 text-micro leading-none";

/**
 * The bare spelling's own sentence, and deliberately not the `data.*` one.
 *
 * `{{data.email}}` is disjoint from the scopes, so "defining one with this name
 * would change nothing" is true of it. A bare `{{email}}` is not: defining that
 * variable does something - it answers every send that carries no row - it just
 * loses to the row while one is picked. Telling the reader it would change
 * nothing would be false, which is why the two messages are two messages.
 */
const BOUND_ROW_NOTE =
	"While a row is picked, its column answers this name. The definition above still resolves on a send that carries no row.";

/**
 * The same note when every definition under the row is switched off.
 *
 * `BOUND_ROW_NOTE` cannot be reused there: "still resolves on a send that
 * carries no row" is precisely what an off definition does not do, and the row
 * would be reassuring the reader about a fallback they do not have. Drop the
 * row and the token goes red - which is the thing worth saying, and only became
 * sayable when the list stopped being drawn for won names alone (issue #1083).
 */
const BOUND_ROW_NOTE_ALL_OFF =
	"While a row is picked, its column answers this name. Every definition below is switched off, so a send that carries no row resolves nothing.";

export interface VariablePopoverProps {
	/** Variable name */
	name: string;
	/** Variable information (value and scope) */
	varInfo: ResolvedVariable | null;
	/** Whether the variable is resolved */
	resolved: boolean;
	/** Callback when value changes (required for editable mode) */
	onValueChange?: (name: string, value: string, scope: VariableScope) => void;
	/** Save mode: 'manual' shows Save/Cancel buttons, 'auto' saves on close */
	saveMode?: "manual" | "auto";
	/** Whether editing is disabled */
	disabled?: boolean;
	/** Custom trigger element */
	trigger: React.ReactNode;
	/** Custom className for trigger */
	triggerClassName?: string;
	/**
	 * Every definition of this name, lowest precedence first, disabled ones
	 * included. Rendered whenever it holds a definition the popover is not
	 * already showing - which is when the question "why is this the value?" has
	 * a non-obvious answer, whether or not the name resolves (issue #1083).
	 */
	origins?: VariableOrigin[];
	/**
	 * Scopes a create can actually be written to. An empty list (or omitted)
	 * means an undefined variable falls back to explaining where to define it,
	 * because there is nowhere this popover could put it.
	 */
	writableScopes?: VariableScope[];
	/**
	 * The trigger's position in a host's roving tab order (issue #1215).
	 * `VariableInput` paints a strip of tokens over one field and passes `-1` to
	 * all but one, so the strip costs a single Tab stop. Defaults to `0`: a token
	 * standing on its own is an ordinary tab stop, and `disabled` still wins.
	 */
	tabIndex?: number;
	/**
	 * Open on mount, for a host that has already decided to open it (issue
	 * #1220): a `{{token}}` in a Monaco editor has no DOM node to click, so the
	 * editor mounts this over the token's screen rectangle already open - a
	 * fresh instance per open, since there is no persistent trigger element to
	 * drive a controlled `open` on instead.
	 */
	defaultOpen?: boolean;
	/**
	 * Drives `isOpen` from outside instead of `defaultOpen`'s once-at-mount
	 * value (issue #1220 hover redesign) - for a host with a real, persistent
	 * trigger element, like `EditableVariable`'s token, that needs to open the
	 * *same* instance for more than one reason (a hover with no focus, a
	 * keyboard chord with one). Mounting a fresh instance per open instead, as
	 * Monaco's anchor does, replaces that element's own DOM node - invisible for
	 * an anchor with nothing else on screen, but for a real, hoverable token it
	 * is a live node destroyed and recreated under the pointer, which the
	 * browser reports as a leave-then-enter of two different elements. That
	 * retriggers whatever hover logic is watching, which is how a hover-driven
	 * remount produced a flicker loop rather than one clean open.
	 *
	 * Left undefined, `isOpen` falls back to `defaultOpen`'s local state,
	 * unchanged from before this prop existed.
	 */
	open?: boolean;
	/**
	 * Told whenever the popover opens or closes, after the save this component
	 * already does on close. A host that positioned the trigger itself uses it
	 * to unmount and to put focus back where it came from - or, with `open`
	 * above, to notice a request to open the same instance it already owns.
	 */
	onOpenChange?: (open: boolean) => void;
	/**
	 * Let focus move into the popover when it opens, instead of leaving it where
	 * it was. Off by default, and that default is the one `VariableInput` needs:
	 * its tokens sit over a live `<input>`, so pulling focus out of the field on
	 * a click in the middle of a URL would take the caret with it. An editor's
	 * token has the opposite need - the popover is opened by a chord, and a
	 * keyboard user who cannot reach what opened is no better off than before.
	 */
	focusOnOpen?: boolean;
	/**
	 * Forwarded straight onto the trigger span (issue #1220 hover redesign): a
	 * host driving its own hover-open/close timers off this exact token needs
	 * the listener on the one element that visually *is* the token, not on an
	 * extra wrapper around it - `VariableInput/`'s font and layout guards read
	 * `[data-variable-token] span` expecting this trigger to be the first span
	 * inside, and a wrapper would put a different one there instead.
	 */
	onMouseEnter?: () => void;
	onMouseLeave?: () => void;
	/**
	 * Told when the pointer enters or leaves the popover's *content*, once it
	 * renders (issue #1220 leave-grace hardening) - ordinary React props on
	 * `PopoverContent` itself, wired below. A host with a leave-grace timer for
	 * a hover-opened popover needs to know when the pointer has actually
	 * reached the content, to cancel a pending close, and when it has left the
	 * content again, to restart one.
	 *
	 * `PopoverContent` is rendered directly in this component's own JSX, so
	 * these fire as part of the very same commit that creates the content's DOM
	 * node - there is no "has the node mounted yet" race to route around, the
	 * way a host reaching for the node from outside (a `document.querySelector`
	 * after a `setTimeout`, or a document-level `mouseover`/`mouseout`
	 * delegation) would have to.
	 */
	onContentMouseEnter?: () => void;
	onContentMouseLeave?: () => void;
}

export function VariablePopover({
	name,
	varInfo,
	resolved,
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
	 * Uncontrolled unless a host passes `open` (see that prop's own comment):
	 * `isOpen` then tracks the prop directly, and `setIsOpen` becomes a no-op
	 * for the host's own state to drive on the next render via `onOpenChange`
	 * instead of writing here twice.
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
	 * Seeds the edit buffer on the transition into open, wherever it came from -
	 * this component's own trigger, or a controlled `open` a host flipped
	 * directly (a hover that never touches the trigger at all).
	 *
	 * Gated on the edge (`isOpen` true, `wasOpen` false) rather than run on every
	 * `isOpen`/`varInfo` change: an effect that re-seeded whenever the parent
	 * handed down a fresh `varInfo` object reset `editValue` under a user
	 * mid-type. The guard makes that impossible - `varInfo` changing while
	 * already open never re-enters the body - which is what lets one effect
	 * cover every path safely instead of each host reseeding by hand.
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
	 * A `data.*` name is not an undefined variable, so none of the undefined
	 * treatment applies to it: it addresses the reserved data namespace (#402),
	 * which is disjoint from the scopes. Creating a variable of that name writes
	 * something that can never answer for the column - both resolvers skip the
	 * scopes for these names by design - so the offer would be a dead end that
	 * leaves the token exactly as it was.
	 *
	 * Guarded here rather than only at the painter because the popover takes its
	 * name as a prop and is reachable from any caller that renders a token.
	 */
	const isDataName = isDataVariableName(name);

	/**
	 * The bound row's answer for this name, if it has one (issue #1064).
	 *
	 * Read off `origins` rather than taken as a prop of its own: the resolver
	 * already ranks the row against the definitions it beats, and a second
	 * channel carrying the same fact is how the winner here and the winner there
	 * come to disagree.
	 */
	const boundRowOrigin = origins?.find((o) => o.scope === "row");

	/**
	 * The definitions this name has that are switched off (issue #1083).
	 *
	 * A name resolves exactly when some definition is enabled, so a name that
	 * does not resolve and still has definitions is one whose every definition
	 * is off - the shape the origin list was built for and the one it could not
	 * reach, because the list only rendered where the name had already won.
	 *
	 * Filtered on `enabled` rather than inferred from `resolved`: the two arrive
	 * as separate props, and a list that describes itself cannot be wrong about
	 * what it holds.
	 */
	const switchedOffDefinitions = (origins ?? []).filter((o) => o.scope !== "row" && !o.enabled);

	// Creating is only offered where a write would land somewhere.
	const creatableScopes = useMemo(
		() => SCOPE_PREFERENCE.filter((s) => writableScopes?.includes(s)),
		[writableScopes]
	);
	const canCreate =
		!resolved && !isDataName && !!onValueChange && !disabled && creatableScopes.length > 0;
	// Held here rather than in the form, which unmounts on close: a scope picked
	// once survives a re-open of the same token.
	const [createScope, setCreateScope] = useState<VariableScope | null>(null);

	const handleOpenChange = (open: boolean) => {
		if (open) {
			openPopover();
		} else {
			// Closing: auto-save if in auto mode and value changed (unless cancelled)
			if (!pendingCancelRef.current && saveMode === "auto" && onValueChange && varInfo) {
				if (editValue !== openValueRef.current) {
					onValueChange(name, editValue, varInfo.scope);
				}
			}
			pendingCancelRef.current = false;
			closePopover();
		}
	};

	const handleSave = () => {
		if (onValueChange && varInfo) {
			onValueChange(name, editValue, varInfo.scope);
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
		onValueChange(name, editValue, scope);
		closePopover();
	};

	/*
	 * `e.preventDefault()` on both keys. Closing hands focus back to the host -
	 * for a Monaco token that is `editor.focus()`, called synchronously inside
	 * this same handler via `onClose` (`useEditorVariableTokens.ts`'s `open`) -
	 * and an unprevented key event applies its own default action to whatever
	 * ends up focused when the browser gets to it, not to the element that was
	 * focused when the event was dispatched. Left unprevented, Enter's default
	 * (insert a newline) landed on Monaco, which this same keydown had just
	 * refocused: editing a token in the body split its line the instant the
	 * popover closed.
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
			// Auto mode: Enter saves, Escape cancels
			if (isCommitEnter(e)) {
				e.preventDefault();
				handleOpenChange(false);
			} else if (e.key === "Escape") {
				e.preventDefault();
				// Mark as cancelled before Radix fires its own onOpenChange for Escape
				pendingCancelRef.current = true;
				closePopover();
			}
		}
	};

	const isSecret = !!varInfo?.secret;

	/**
	 * The trigger is a `<span>`, because a `{{variable}}` token sits inline in the
	 * middle of a URL or a header value and must not break the text flow.
	 *
	 * Radix's `asChild` clones its click handler and `aria-*` onto this span, but
	 * it does not make a span focusable - it assumes the child is already an
	 * interactive element. So every variable token in the app was mouse-only: a
	 * keyboard user could not open the popover to see what a variable resolved
	 * to, or edit it, anywhere in the URL bar, headers, params or auth fields.
	 *
	 * `role="button"` plus `tabIndex` plus Enter/Space is what a `<button>` would
	 * have given for free, minus the block-level layout that would wreck the
	 * inline flow. `disabled` tokens leave the tab order rather than sitting in it
	 * doing nothing.
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
				 * A click dispatched by the "Edit variable" menu command
				 * (`lib/context-menu.ts`) carries this sentinel instead of an
				 * ordinary click count - a deliberate, explicit request to open,
				 * unlike an ordinary pointer click, which places a caret in the
				 * underlying text instead (`VariableInput/index.tsx`) and must
				 * open nothing here.
				 */
				if (e.detail !== MENU_TRIGGERED_CLICK_DETAIL) {
					/*
					 * `PopoverTrigger asChild` composes Radix's own click-to-toggle
					 * handler with this one (`composeEventHandlers`), which still
					 * runs unless the event's default was prevented - so an ordinary
					 * click would otherwise open the popover through Radix's own
					 * handler regardless of anything decided here.
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
					// Space in particular: the token is usually inside a text input,
					// where it would otherwise type a space.
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
				// `w-sm` (24rem), not `w-96`: the card holds the variable's name,
				// value and source, a text measure, and `w-96` rides `--spacing` -
				// 288px at the Default density rather than the 384px `w-sm` reads
				// as.
				className="w-sm max-w-[calc(100vw-2rem)] p-2.5"
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
					 * Radix's `DismissableLayer` closes on Escape through a
					 * document-level listener that runs before this component's own
					 * `<Input>` ever sees the key (capture beats the input's bubble
					 * handler) - so the flag set there arrived too late, and Radix's
					 * own call to `onOpenChange(false)` (`handleOpenChange` below)
					 * ran its auto-save check first, committing whatever was typed.
					 * Setting it here, in the callback Radix itself invokes as part
					 * of that same dismissal, guarantees it lands before
					 * `handleOpenChange` reads it, however either handler races.
					 */
					pendingCancelRef.current = true;
				}}
				onOpenAutoFocus={(e) => {
					// See `focusOnOpen`: a token over a live input must not take the
					// caret with it, and a token opened by a chord must be reachable.
					if (!focusOnOpen) e.preventDefault();
				}}
			>
				<div className="flex flex-col gap-2">
					{/*
					 * Name, whether it is a secret, and where it came from.
					 *
					 * `items-center` throughout, not `items-baseline`. Baseline
					 * alignment lines up the *text* baselines of boxes whose contents
					 * differ, and the Secret chip carries an icon while the scope badge
					 * does not - so the two chips sat at visibly different heights.
					 * Chips beside a title are centred, not baselined.
					 *
					 * Both chips are pinned to the same 18px so neither can drift when
					 * one gains content the other has not.
					 */}
					<div className="flex flex-row items-center justify-between gap-2">
						<span className="font-mono text-sm font-semibold truncate">{name}</span>
						<div className="flex shrink-0 items-center gap-1.5">
							{/*
							 * The secret mark sits here beside the scope rather than
							 * owning a labelled row of its own. It is a property of the
							 * variable, like its scope - not a section.
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
								 * Answered, so not "undefined" - and in the accent rather
								 * than the destructive red, which states a token that will
								 * reach the server with its braces still on. This one will
								 * not: the row carries the column.
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

					{resolved && varInfo ? (
						<>
							{/*
							 * Where the value lives, on a line of its own (issue #1320).
							 *
							 * It used to share the footer with the Enter and Esc keycaps:
							 * a `truncate` span beside a `shrink-0` chip group inside a
							 * `w-72` card, so "Shopify QA - expiring tokens" rendered as
							 * "Shopify QA - expiring…" and the popover clipped the one
							 * fact it was opened to give. That is the shape the tooltips
							 * already ruled out (issue #1195, `docs/design-system.md`);
							 * this is the same shape one primitive over, so it takes the
							 * same answer - the source stacks, full width, nothing
							 * competing with it horizontally.
							 *
							 * Two lines at most, with the whole name on `title` for the
							 * environment named at essay length. A definition with no
							 * source name - a global - prints its scope word instead, so
							 * the line is always here and the card does not change height
							 * between scopes.
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
						 * Undefined everywhere, but the picked row carries the column, so
						 * the send resolves it. "Not defined in any scope" in destructive red
						 * is the one thing this must not say: the red states a token that
						 * will reach the server with its braces on, and this one will not.
						 */
						<div className="text-sm text-muted-foreground">
							Answered by the bound data row&rsquo;s{" "}
							<span className="font-mono">{name}</span> column, not by a variable.
							Defining one would answer a send that carries no row.
						</div>
					) : switchedOffDefinitions.length > 0 ? (
						/*
						 * Defined, and still red: the token does not resolve, so the red
						 * is honest. What was not honest is the sentence - "not defined"
						 * printed directly above a list showing where it is defined, with
						 * an `off` badge on it, tells the reader to go and do the one
						 * thing they have already done (issue #1083).
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
					 * Outside the branch chain, because "where could this have come
					 * from" is the same question in every state above, and the state
					 * most likely to raise it - a name whose only definition is switched
					 * off - is one of the ones that could not ask it (issue #1083).
					 *
					 * `data.*` is the exception rather than an oversight: the reserved
					 * namespace is disjoint from the scopes, so a definition of that
					 * name never answers for the column and listing it would say it
					 * might.
					 */}
					{!isDataName && <ShadowedBy origins={origins} />}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * One line of the "where could this have come from" list.
 *
 * Shared by the winning row and the definitions beneath it so the two cannot
 * drift apart: the only difference between them is the strike-through, which is
 * the whole message - a struck value is one the send will not use.
 */
function OriginRow({ origin, beaten }: { origin: VariableOrigin; beaten: boolean }) {
	// A disabled definition is not competing at all, so it does not get a
	// colour. The row gets the accent rather than a fourth scope colour: it is
	// not a place a variable lives, it is the answer that is live right now, and
	// the accent is what this app already paints a live answer in.
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
 * Where the value comes from, and what it beat.
 *
 * Rendered when the list holds a definition the popover is not already showing,
 * so the ordinary case stays short: a name with one definition that wins has
 * nothing to add - the field above it *is* that definition - and lists nothing.
 * Three row states, not two - a definition can lose by precedence *or* by being
 * switched off, and the second is the more common surprise: the value you set is
 * being skipped rather than missing. A list that only showed shadowing would
 * answer the easy question and stay silent on the hard one.
 *
 * The gate used to be `origins.length < 2`, which reached the same answer for a
 * winner and the wrong one for a name whose *only* definition is switched off:
 * one entry, nothing above it showing that entry, and the list suppressed
 * anyway (issue #1083). Counting entries was standing in for the question the
 * next line actually asks - is any of them not the winner.
 *
 * A bound row's cell is listed above them all, unstruck (issue #1064). Without
 * it the popover explained a value the send would not use: the editable field at
 * the top of the popover is the *variable*, which is still the thing you can
 * change, while the row is what answers the name until the pick is dropped.
 */
function ShadowedBy({ origins }: { origins?: VariableOrigin[] }) {
	if (!origins || origins.length === 0) return null;

	// Highest precedence first: reading down the list is reading the order the
	// resolver rejected them in.
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
			 * Still "also defined" with a row above, not "shadowed": the list holds
			 * definitions that lost by precedence *and* ones that are switched off,
			 * and an off definition is not shadowed by anything. The row block above
			 * already says which answer wins.
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

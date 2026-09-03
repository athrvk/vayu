/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variable Popover
 *
 * What opens when you click a `{{token}}`. Three states:
 *
 *   resolved   the value, editable, with the environment or collection it came
 *              from and every other definition that lost
 *   undefined  a value field and a scope to create it in
 *   read-only  the value, when there is no way to change it from here
 *
 * **A bound data row outranks all of them** (D18, issue #1007). While one is
 * picked its column answers a bare name above every scope, so the popover names
 * the row as the origin and strikes the definitions beneath it (issue #1064).
 * Without that it explained, in full detail, a value the send was not going to
 * use - the one question this popover exists to answer, answered wrongly.
 *
 * **Not resolving is not the same as not being defined** (issue #1083). A name
 * whose every definition is switched off has no winner, so it arrives here
 * unresolved and used to be offered a form to create what it already has. The
 * list of definitions is drawn under every state rather than under the resolved
 * one alone, because "the value you set is being skipped" is the question it was
 * added to answer and that is the state which asks it.
 *
 * **It used to show the value twice.** A "Current Value" block sat above an
 * "Edit Value" input holding the same string, each with its own label and its
 * own secret-reveal button - about 90px and two labels spent restating what the
 * editable field already said. The editable field *is* the current value, so
 * that block now renders only where it does real work: a secret, which must be
 * masked until deliberately revealed, and the not-editable case.
 *
 * The space it freed goes to the two things the popover is opened to find out
 * and previously could not answer - *which* environment this came from, and why
 * this value won over the others.
 *
 * **Undefined variables used to be a dead end.** The popover said "Define it in
 * Globals, an Environment, or Collection variables" and offered no way to do
 * any of that, which is unhelpful for what is by far the most common reason to
 * click a red token. It can now create one - but only into a scope the caller
 * says is writable, because `updateVariable` silently no-ops when the target
 * scope has no active target (no environment selected, no collection). Offering
 * a scope that cannot be written is a Create button that does nothing.
 */

import { useState, useRef, useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Button } from "./button";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Input } from "./input";
import { Kbd } from "./kbd";
import { VariableScopeBadge, type VariableScope } from "./variable-scope-badge";
import { VARIABLE_SCOPE_CONFIG, VARIABLE_SCOPE_DOT } from "@/constants/variables";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import { isDataVariableName } from "@/lib/variable-resolution";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import type { ResolvedVariable, VariableOrigin } from "@/types";

// Re-export ResolvedVariable as VariableInfo for backward compatibility
export type { ResolvedVariable as VariableInfo };

/** Highest precedence first - the scope a new variable most likely belongs in. */
const SCOPE_PREFERENCE: VariableScope[] = ["environment", "collection", "global"];

/**
 * A **fixed-width** stand-in for a hidden secret.
 *
 * Deliberately not `"•".repeat(value.length)` and deliberately not a
 * `type="password"` input holding the real string: both draw one dot per
 * character, which tells anyone looking how long the secret is. A two-character
 * value rendering as two dots is a meaningful leak, and it was also visibly
 * inconsistent with the fixed eight-dot box that used to sit above it.
 */
const SECRET_MASK = "••••••••";

/**
 * What a `"row"` origin calls itself. A row has no `sourceName` to give - it is
 * the one row currently picked, not a file or an environment someone named.
 */
const BOUND_ROW_LABEL = "Bound row";

/**
 * The chip beside the name when there is no scope badge to show. Shared rather
 * than spelled out per state: it was already written twice, and the third copy
 * is where a shape or radius fix starts reaching only two of them.
 */
const NAME_CHIP =
	"inline-flex h-[18px] items-center rounded-md border px-1.5 text-[10px] font-semibold leading-none";

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

/** The eye that swaps a hidden secret field for an editable one. */
function RevealButton({
	revealed,
	onToggle,
	autoFocus,
}: {
	revealed: boolean;
	onToggle: () => void;
	/** See the hidden-secret branch below - this is its only entry point. */
	autoFocus?: boolean;
}) {
	return (
		<TooltipIconButton
			label={revealed ? "Hide value" : "Reveal value"}
			icon={revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
			onClick={onToggle}
			autoFocus={autoFocus}
			className="absolute right-0 top-0 h-8 w-8 text-muted-foreground hover:text-foreground"
		/>
	);
}

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
	 * editor mounts this over the token's screen rectangle already open.
	 *
	 * Deliberately `defaultOpen` and not a controlled `open`: opening seeds the
	 * edit buffer from `varInfo`, and the initial state below does that for free.
	 * A controlled prop would need an effect to re-seed on every external open,
	 * which is the effect that used to reset the buffer under a user mid-type.
	 */
	defaultOpen?: boolean;
	/**
	 * Told whenever the popover opens or closes, after the save this component
	 * already does on close. A host that positioned the trigger itself uses it
	 * to unmount and to put focus back where it came from.
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
	onOpenChange,
	focusOnOpen = false,
}: VariablePopoverProps) {
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const [editValue, setEditValue] = useState(varInfo?.value || "");
	const [isSecretRevealed, setIsSecretRevealed] = useState(false);
	const openValueRef = useRef(varInfo?.value || "");
	const pendingCancelRef = useRef(false);

	/**
	 * Opening seeds the edit buffer from the variable, and closing drops the
	 * reveal so a secret is masked again next time.
	 *
	 * Both belong to the open/close *event*, not to a render: seeding from an
	 * effect keyed on `isOpen` re-ran whenever the parent handed down a fresh
	 * `varInfo` object, which reset `editValue` under a user mid-type (the
	 * reason the effect carried an `exhaustive-deps` suppression).
	 */
	const openPopover = () => {
		if (varInfo) {
			openValueRef.current = varInfo.value;
			setEditValue(varInfo.value);
		}
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
	const [createScope, setCreateScope] = useState<VariableScope | null>(null);
	// Falls back rather than storing a default, so a scope that stops being
	// writable (the environment was deselected) cannot leave a stale selection
	// pointing at a no-op.
	const activeCreateScope =
		createScope && creatableScopes.includes(createScope) ? createScope : creatableScopes[0];

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

	const handleCreate = () => {
		if (!onValueChange || !activeCreateScope) return;
		onValueChange(name, editValue, activeCreateScope);
		closePopover();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (saveMode === "manual") {
			if (isCommitEnter(e)) {
				handleSave();
			} else if (e.key === "Escape") {
				handleCancel();
			}
		} else {
			// Auto mode: Enter saves, Escape cancels
			if (isCommitEnter(e)) {
				handleOpenChange(false);
			} else if (e.key === "Escape") {
				// Mark as cancelled before Radix fires its own onOpenChange for Escape
				pendingCancelRef.current = true;
				closePopover();
			}
		}
	};

	/*
	 * A secret keeps the two-stage display the rest of the popover dropped: it
	 * is masked until revealed, so the editable field cannot simply *be* the
	 * value on screen. This is the one case the old duplicate block was earning
	 * its space.
	 */
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
			className={triggerClassName}
			onClick={(e) => {
				if (disabled) return;
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
			style={{ display: "inline" }}
		>
			{trigger}
		</span>
	);

	return (
		<Popover open={isOpen} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
			<PopoverContent
				className="w-72 p-2.5"
				align="start"
				side="bottom"
				onClick={(e) => e.stopPropagation()}
				onPointerDownOutside={(e) => {
					if (saveMode === "manual") {
						e.preventDefault();
					}
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
								<span
									title="Secret - hidden until revealed"
									className="inline-flex h-[18px] items-center gap-1 rounded-md border border-warning-text/40 px-1.5 text-[10px] font-semibold leading-none text-warning-text"
								>
									<KeyRound className="h-2.5 w-2.5" />
									Secret
								</span>
							)}
							{varInfo ? (
								<VariableScopeBadge
									scope={varInfo.scope}
									variant="full"
									className="h-[18px] leading-none"
								/>
							) : isDataName ? (
								<span
									className={cn(
										NAME_CHIP,
										"border-muted-foreground/40 text-muted-foreground"
									)}
								>
									data
								</span>
							) : boundRowOrigin ? (
								/*
								 * Answered, so not "undefined" - and in the accent rather
								 * than the destructive red, which states a token that will
								 * reach the server with its braces still on. This one will
								 * not: the row carries the column.
								 */
								<span className={cn(NAME_CHIP, "border-primary/40 text-primary")}>
									row
								</span>
							) : (
								<span
									className={cn(
										NAME_CHIP,
										"border-destructive-text/40 text-destructive-text"
									)}
								>
									undefined
								</span>
							)}
						</div>
					</div>

					{resolved && varInfo ? (
						<>
							{/*
							 * One field for a secret too.
							 *
							 * It used to be two, and they disagreed: a read-only box
							 * printing a fixed `••••••••` sat above a `type="password"`
							 * input printing the *real* value masked - so a two-character
							 * secret showed eight dots in one box and two in the other,
							 * and the second **leaked the length**. That is the same
							 * duplicate the rest of this popover dropped, reintroduced
							 * with a disclosure bug on top.
							 *
							 * Hidden, the field is read-only and shows a fixed-width mask,
							 * so nothing about the value is inferable and it cannot be
							 * edited blind. Revealing turns it into an ordinary editable
							 * field - one control, two states, and the eye is the only
							 * thing that moves between them.
							 */}
							{canEdit ? (
								isSecret && !isSecretRevealed ? (
									<div className="relative">
										<Input
											/*
											 * Keyed against the revealed field below,
											 * which is otherwise the same `<Input>` in
											 * the same slot: React would reconcile the
											 * two rather than remount, and `autoFocus`
											 * fires on mount - so revealing left focus
											 * behind on the eye and the field the reveal
											 * exists to open had to be tabbed back to.
											 */
											key="secret-masked"
											readOnly
											value={varInfo.value ? SECRET_MASK : ""}
											placeholder="not set"
											aria-label={`Value of ${name} (hidden)`}
											className="h-8 select-none pr-8 font-mono text-sm"
										/>
										<RevealButton
											revealed={false}
											onToggle={() => setIsSecretRevealed(true)}
											/*
											 * The popover suppresses its own open-autofocus, and every
											 * other branch compensates with `autoFocus` on the field it
											 * opens onto. This one had nothing: the masked field is
											 * `readOnly`, and the popover is non-modal and portalled, so
											 * Tab from the token did not enter it and focus-outside
											 * dismissed it - a secret was the one variable a keyboard
											 * user could not read (issue #1215). The eye is the right
											 * landing: revealing is the only action here, and it hands
											 * focus on to the editable field.
											 */
											autoFocus
										/>
									</div>
								) : (
									<div className="relative">
										<Input
											key="secret-revealed"
											value={editValue}
											onChange={(e) => setEditValue(e.target.value)}
											onKeyDown={handleKeyDown}
											className={cn(
												"h-8 font-mono text-sm",
												isSecret && "pr-8"
											)}
											aria-label={`Value of ${name}`}
											autoFocus
										/>
										{isSecret && (
											<RevealButton
												revealed
												onToggle={() => setIsSecretRevealed(false)}
											/>
										)}
									</div>
								)
							) : (
								<div className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all">
									{isSecret && !isSecretRevealed ? (
										<span className="select-none">{SECRET_MASK}</span>
									) : (
										varInfo.value || (
											<span className="italic text-muted-foreground">
												empty
											</span>
										)
									)}
								</div>
							)}

							{/*
							 * Source and keyboard hints on one line. This replaces
							 * "Auto-saves when you click away" - a permanent sentence
							 * for a behaviour that is only surprising once - with the
							 * two facts that stay useful: where the value lives, and
							 * the keys that already worked but were never shown.
							 */}
							{canEdit && saveMode === "auto" && (
								<div className="flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
									<span className="truncate">
										{varInfo.sourceName ? (
											<>
												from{" "}
												<span className="font-medium text-foreground">
													{varInfo.sourceName}
												</span>
											</>
										) : (
											"saves when you click away"
										)}
									</span>
									{/*
									 * Real keycaps here, unlike the URL bar's buttons. This footer
									 * sits on `bg-popover` - a surface - which is what `Kbd`'s
									 * default tone is built for. The buttons could not use it:
									 * they paint their own accent, and a `--muted` cap stamped on
									 * that reads as a grey chip.
									 */}
									<span className="flex shrink-0 items-center gap-1">
										<Kbd size="sm">↵</Kbd>
										<span>save</span>
										<Kbd size="sm" className="ml-1">
											esc
										</Kbd>
										<span>cancel</span>
									</span>
								</div>
							)}

							{/* Action Buttons (manual mode only) */}
							{saveMode === "manual" && canEdit && (
								<div className="flex justify-end gap-2">
									<Button size="sm" variant="ghost" onClick={handleCancel}>
										Cancel
									</Button>
									<Button size="sm" onClick={handleSave}>
										Save
									</Button>
								</div>
							)}
						</>
					) : canCreate ? (
						<>
							<Input
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										handleCreate();
									}
								}}
								placeholder="value…"
								className="h-8 font-mono text-sm"
								aria-label={`Value for new variable ${name}`}
								autoFocus
							/>
							<div className="flex items-center gap-1.5">
								<span className="shrink-0 text-[10px] text-muted-foreground">
									create in
								</span>
								{/*
								 * Only writable scopes appear. A picker offering
								 * "Environment" with none selected would produce a
								 * Create button that silently does nothing.
								 */}
								{creatableScopes.map((scope) => (
									<button
										key={scope}
										type="button"
										onClick={() => setCreateScope(scope)}
										aria-pressed={scope === activeCreateScope}
										className={cn(
											"rounded-md border px-1.5 py-0.5 text-[10px] transition-colors",
											scope === activeCreateScope
												? cn(
														VARIABLE_SCOPE_CONFIG[scope].tint,
														VARIABLE_SCOPE_CONFIG[scope].border
													)
												: "border-transparent text-muted-foreground hover:bg-accent"
										)}
									>
										{VARIABLE_SCOPE_CONFIG[scope].full}
									</button>
								))}
								<Button
									size="sm"
									className="ml-auto h-6 px-2 text-[11px]"
									onClick={handleCreate}
								>
									Create
								</Button>
							</div>
							{/*
							 * A create offer must not imply the token is unanswered. The
							 * row carries a column the declared contract does not, so the
							 * painter never diverted this token and the send resolves it
							 * anyway - creating a variable here is still worth doing, but
							 * for the sends that carry no row, not for this one.
							 */}
							{boundRowOrigin && (
								<p className="text-[10px] text-muted-foreground">
									The bound row already answers this name with{" "}
									<span className="font-mono">
										{boundRowOrigin.value || "empty"}
									</span>
									. A variable created here answers a send that carries no row.
								</p>
							)}
							{/*
							 * The create offer stays, and says what it is doing (issue
							 * #1083). Replacing it with a switch would be the closer
							 * answer, and this popover cannot give it: it writes values
							 * through `onValueChange`, which carries no enabled flag, so
							 * the toggle lives in the variables editor. Offering to
							 * create in silence is the part that misleads - the reader
							 * is one toggle away from a value and is being handed a
							 * form that adds a second definition instead.
							 */}
							{switchedOffDefinitions.length > 0 && (
								<p className="text-[10px] text-muted-foreground">
									{switchedOffDefinitions.length === 1
										? "This name is already defined below, switched off."
										: `This name is already defined ${switchedOffDefinitions.length} times below, every one switched off.`}{" "}
									Switching one back on answers the token; creating here adds
									another definition and leaves it off.
								</p>
							)}
						</>
					) : isDataName ? (
						<div className="text-sm text-muted-foreground">
							Bound per iteration by the run&rsquo;s data file. Not a variable -
							defining one with this name would change nothing.
						</div>
					) : boundRowOrigin ? (
						/*
						 * Undefined everywhere, but the picked row carries the column, so
						 * the send resolves it. "Variable not defined" in destructive red
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
						<div className="text-sm text-destructive-text">
							Defined, but every definition is switched off, so this token does not
							resolve.
						</div>
					) : (
						<div className="text-sm text-destructive-text">
							Variable not defined. Define it in Globals, an Environment, or
							Collection variables.
						</div>
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
		<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
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
					<div className="text-[10px] uppercase tracking-wide text-subtle-foreground">
						bound data row
					</div>
					<OriginRow origin={row} beaten={false} />
				</>
			)}
			{/*
			 * Still "also defined" with a row above, not "shadowed": the list holds
			 * definitions that lost by precedence *and* ones that are switched off,
			 * and an off definition is not shadowed by anything. The row block above
			 * already says which answer wins.
			 */}
			<div className="text-[10px] uppercase tracking-wide text-subtle-foreground">
				also defined
			</div>
			{others.map((o, i) => (
				<OriginRow key={`${o.scope}-${o.sourceId ?? "global"}-${i}`} origin={o} beaten />
			))}
			{row && (
				<p className="text-[10px] text-muted-foreground">
					{others.some((o) => o.enabled) ? BOUND_ROW_NOTE : BOUND_ROW_NOTE_ALL_OFF}
				</p>
			)}
		</div>
	);
}

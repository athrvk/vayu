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

import { useState, useEffect, useRef, useMemo } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Button } from "./button";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Input } from "./input";
import { VariableScopeBadge, type VariableScope } from "./variable-scope-badge";
import { VARIABLE_SCOPE_CONFIG, VARIABLE_SCOPE_DOT } from "@/constants/variables";
import { cn } from "@/lib/utils";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import type { ResolvedVariable, VariableOrigin } from "@/types";

// Re-export ResolvedVariable as VariableInfo for backward compatibility
export type { ResolvedVariable as VariableInfo };

/** Highest precedence first - the scope a new variable most likely belongs in. */
const SCOPE_PREFERENCE: VariableScope[] = ["environment", "collection", "global"];

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
	 * included. Rendered only when there is more than one, which is when the
	 * question "why is this the value?" has a non-obvious answer.
	 */
	origins?: VariableOrigin[];
	/**
	 * Scopes a create can actually be written to. An empty list (or omitted)
	 * means an undefined variable falls back to explaining where to define it,
	 * because there is nowhere this popover could put it.
	 */
	writableScopes?: VariableScope[];
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
}: VariablePopoverProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [editValue, setEditValue] = useState(varInfo?.value || "");
	const [isSecretRevealed, setIsSecretRevealed] = useState(false);
	const openValueRef = useRef(varInfo?.value || "");
	const pendingCancelRef = useRef(false);

	// Reset reveal state when popover closes
	useEffect(() => {
		if (!isOpen) {
			setIsSecretRevealed(false);
		}
	}, [isOpen]);

	// Keep editValue in sync with varInfo when popover is closed
	const varInfoValue = varInfo?.value;
	useEffect(() => {
		if (!isOpen && varInfoValue !== undefined) {
			setEditValue(varInfoValue);
		}
	}, [varInfoValue, isOpen]);

	// Initialize ref when opening - varInfo intentionally excluded so external
	// reference churn (e.g. inline object creation in parent) doesn't reset
	// editValue while the user is typing.
	useEffect(() => {
		if (isOpen && varInfo) {
			openValueRef.current = varInfo.value;
			setEditValue(varInfo.value);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOpen]);

	const canEdit = !!onValueChange && !!varInfo && resolved && !disabled;

	// Creating is only offered where a write would land somewhere.
	const creatableScopes = useMemo(
		() => SCOPE_PREFERENCE.filter((s) => writableScopes?.includes(s)),
		[writableScopes]
	);
	const canCreate = !resolved && !!onValueChange && !disabled && creatableScopes.length > 0;
	const [createScope, setCreateScope] = useState<VariableScope | null>(null);
	// Falls back rather than storing a default, so a scope that stops being
	// writable (the environment was deselected) cannot leave a stale selection
	// pointing at a no-op.
	const activeCreateScope =
		createScope && creatableScopes.includes(createScope) ? createScope : creatableScopes[0];

	const handleOpenChange = (open: boolean) => {
		if (open) {
			setIsOpen(true);
		} else {
			// Closing: auto-save if in auto mode and value changed (unless cancelled)
			if (!pendingCancelRef.current && saveMode === "auto" && onValueChange && varInfo) {
				if (editValue !== openValueRef.current) {
					onValueChange(name, editValue, varInfo.scope);
				}
			}
			pendingCancelRef.current = false;
			setIsOpen(false);
		}
	};

	const handleSave = () => {
		if (onValueChange && varInfo) {
			onValueChange(name, editValue, varInfo.scope);
		}
		setIsOpen(false);
	};

	const handleCancel = () => {
		if (varInfo) {
			setEditValue(varInfo.value);
		}
		setIsOpen(false);
	};

	const handleCreate = () => {
		if (!onValueChange || !activeCreateScope) return;
		onValueChange(name, editValue, activeCreateScope);
		setIsOpen(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (saveMode === "manual") {
			if (e.key === "Enter") {
				handleSave();
			} else if (e.key === "Escape") {
				handleCancel();
			}
		} else {
			// Auto mode: Enter saves, Escape cancels
			if (e.key === "Enter") {
				handleOpenChange(false);
			} else if (e.key === "Escape") {
				// Mark as cancelled before Radix fires its own onOpenChange for Escape
				pendingCancelRef.current = true;
				setIsOpen(false);
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
			tabIndex={disabled ? -1 : 0}
			className={triggerClassName}
			onClick={(e) => {
				if (disabled) return;
				e.stopPropagation(); // Prevent input blur
				if (!isOpen) setIsOpen(true);
			}}
			onKeyDown={(e) => {
				if (disabled) return;
				if (e.key === "Enter" || e.key === " ") {
					// Space in particular: the token is usually inside a text input,
					// where it would otherwise type a space.
					e.preventDefault();
					e.stopPropagation();
					setIsOpen(true);
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
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex flex-col gap-2">
					{/* Name + where it came from */}
					<div className="flex flex-row items-baseline justify-between gap-2">
						<span className="font-mono text-sm font-semibold truncate">{name}</span>
						{varInfo ? (
							<VariableScopeBadge scope={varInfo.scope} variant="full" />
						) : (
							<span className="shrink-0 rounded-md border border-destructive-text/40 px-1.5 text-[10px] text-destructive-text">
								undefined
							</span>
						)}
					</div>

					{resolved && varInfo ? (
						<>
							{/*
							 * Masked read-only display, secrets only. Everything else
							 * edits in place - the field below is the current value.
							 */}
							{isSecret && (
								<div className="flex flex-col gap-1">
									<div className="flex items-center gap-1 text-[10px] text-warning-text">
										<KeyRound className="w-3 h-3" />
										Secret
									</div>
									<div className="relative rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all">
										{!isSecretRevealed ? (
											<span className="select-none">••••••••</span>
										) : varInfo.value ? (
											varInfo.value
										) : (
											<span className="italic text-muted-foreground">
												empty
											</span>
										)}
										{varInfo.value && (
											<TooltipIconButton
												label={
													isSecretRevealed ? "Hide value" : "Reveal value"
												}
												icon={
													isSecretRevealed ? (
														<EyeOff className="w-3 h-3" />
													) : (
														<Eye className="w-3 h-3" />
													)
												}
												onClick={() =>
													setIsSecretRevealed(!isSecretRevealed)
												}
												className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground hover:text-foreground"
											/>
										)}
									</div>
								</div>
							)}

							{canEdit ? (
								<Input
									type={isSecret && !isSecretRevealed ? "password" : "text"}
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={handleKeyDown}
									className="h-8 font-mono text-sm"
									aria-label={`Value of ${name}`}
									autoFocus
								/>
							) : (
								!isSecret && (
									<div className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm break-all">
										{varInfo.value || (
											<span className="italic text-muted-foreground">
												empty
											</span>
										)}
									</div>
								)
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
									<span className="shrink-0 font-mono opacity-80">
										⏎ save · esc cancel
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

							<ShadowedBy origins={origins} />
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
						</>
					) : (
						<div className="text-sm text-destructive-text">
							Variable not defined. Define it in Globals, an Environment, or
							Collection variables.
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The definitions that did not win.
 *
 * Rendered only when there is more than one, so the ordinary case stays short.
 * Three row states, not two - a definition can lose by precedence *or* by being
 * switched off, and the second is the more common surprise: the value you set
 * is being skipped rather than missing. A list that only showed shadowing would
 * answer the easy question and stay silent on the hard one.
 */
function ShadowedBy({ origins }: { origins?: VariableOrigin[] }) {
	if (!origins || origins.length < 2) return null;

	// Highest precedence first: reading down the list is reading the order the
	// resolver rejected them in.
	const others = [...origins].reverse().filter((o) => !o.winner);
	if (others.length === 0) return null;

	return (
		<div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
			<div className="text-[10px] uppercase tracking-wide text-subtle-foreground">
				also defined
			</div>
			{others.map((o, i) => (
				<div
					key={`${o.scope}-${o.sourceId ?? "global"}-${i}`}
					className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
				>
					<span
						className={cn(
							"size-[5px] shrink-0 rounded-full",
							// A disabled definition is not competing at all, so it does
							// not get the scope's colour.
							o.enabled ? VARIABLE_SCOPE_DOT[o.scope] : "bg-subtle-foreground"
						)}
					/>
					<span className="shrink-0">
						{o.sourceName ?? VARIABLE_SCOPE_CONFIG[o.scope].full}
					</span>
					<span className="truncate font-mono line-through opacity-60">
						{o.secret ? "••••••••" : o.value || "empty"}
					</span>
					{!o.enabled && (
						<span className="ml-auto shrink-0 rounded-md border border-rule px-1 not-italic">
							off
						</span>
					)}
				</div>
			))}
		</div>
	);
}

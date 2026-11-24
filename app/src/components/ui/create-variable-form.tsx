/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `VariablePopover`'s undefined branch: a value, whether it is a secret, a scope, and Create. The
 * value, secret flag and scope are held by the popover: its content unmounts on close, the value is
 * the buffer the close path reads, and a flag or scope picked once survives re-opening the token.
 */

import { useEffect, useId, useRef } from "react";
import { KeyRound } from "lucide-react";
import type { VariableOrigin } from "@/types";
import { VARIABLE_SCOPE_CONFIG } from "@/constants/variables";
import { isCommitEnter } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { SecretInput } from "./secret-input";
import { TooltipIconButton } from "./tooltip-icon-button";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import type { VariableScope } from "./variable-scope-badge";

export interface CreateVariableFormProps {
	name: string;
	/** The scopes a create can be written to, highest precedence first. Never empty. */
	scopes: VariableScope[];
	/** The user's pick; `null`, or a scope no longer writable, means the first. */
	selectedScope: VariableScope | null;
	onSelectedScopeChange: (scope: VariableScope) => void;
	/** Whether the new entry is stored as a secret; the value field masks while it is. */
	secret: boolean;
	onSecretChange: (secret: boolean) => void;
	value: string;
	onValueChange: (value: string) => void;
	/** Called only with a non-empty value. */
	onCreate: (scope: VariableScope) => void;
	/**
	 * A real DOM attribute, so it fires on mount whatever Radix's `onOpenAutoFocus` decided; an
	 * inert (hover) open passes false.
	 */
	autoFocus: boolean;
	/** The bound row's answer for this name, when one is picked (issue #1064). */
	boundRowOrigin?: VariableOrigin;
	/** How many definitions of this name exist and are switched off (issue #1083). */
	switchedOffCount: number;
}

export function CreateVariableForm({
	name,
	scopes,
	selectedScope,
	onSelectedScopeChange,
	secret,
	onSecretChange,
	value,
	onValueChange,
	onCreate,
	autoFocus,
	boundRowOrigin,
	switchedOffCount,
}: CreateVariableFormProps) {
	// A fallback, not a stored default, so a scope that stops being writable (its environment
	// deselected) leaves no stale selection pointing at a no-op.
	const activeScope = selectedScope && scopes.includes(selectedScope) ? selectedScope : scopes[0];
	const valueRef = useRef<HTMLInputElement>(null);
	const scopeLabelId = useId();
	const refocusValue = useRef(false);

	// The toggle swaps `Input` for `SecretInput`, remounting the field while the clicked button
	// keeps focus. After commit, so the ref holds the new input, and only for a toggle from here: a
	// first mount or a StrictMode re-run must not take focus the open declined. `SecretInput` has
	// no `autoFocus`: a keyboard open lets Radix focus the first tabbable, its field.
	useEffect(() => {
		if (!refocusValue.current) return;
		refocusValue.current = false;
		valueRef.current?.focus();
	}, [secret]);

	/**
	 * An empty field is no variable worth writing (#1380): `mergeVariable` stores what it gets, so
	 * `""` defines the name and the token stops reading undefined while answering nothing. Refused,
	 * not trimmed: spaces are a value the user typed.
	 */
	const canSubmit = value.length > 0;

	const create = () => {
		if (!activeScope || !canSubmit) return;
		onCreate(activeScope);
	};

	const valueField = {
		size: "sm",
		ref: valueRef,
		value,
		placeholder: "value…",
		"aria-label": `Value for new variable ${name}`,
		onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
			// `isCommitEnter`, not a bare Enter (#939): an IME commits with the same keydown, and
			// Send is Ctrl/Cmd+Enter.
			if (isCommitEnter(e)) {
				e.preventDefault();
				create();
			}
		},
	} as const;

	/**
	 * Picking a scope qualifies the value, not a destination (#1380): a segment is a `<button>` and
	 * takes focus on click, and the field's `autoFocus` ran only at mount, so the click hands focus
	 * back to the value. Radix clears the value when the active segment is pressed again; a scope
	 * has no "off", so `""` means "keep it" and only the refocus remains.
	 */
	const selectScope = (next: string) => {
		const scope = scopes.find((s) => s === next);
		if (scope) onSelectedScopeChange(scope);
		valueRef.current?.focus();
	};

	const toggleSecret = () => {
		refocusValue.current = true;
		onSecretChange(!secret);
	};

	return (
		<>
			<div className="flex items-center gap-1">
				<div className="min-w-0 flex-1">
					{/*
					 * `SecretInput` while the entry is a secret, the primitive the Variables editor
					 * masks secret rows with: typed here, so masked but editable, with the eye
					 * beside it.
					 */}
					{secret ? (
						<SecretInput {...valueField} onChange={onValueChange} />
					) : (
						<Input
							{...valueField}
							autoFocus={autoFocus}
							onChange={(e) => onValueChange(e.target.value)}
							className="font-mono text-sm"
						/>
					)}
				</div>
				{/*
				 * The Variables editor's control and labels, so one mark has one name. Off by
				 * default: a variable is plain unless chosen otherwise, and the entry is unchanged
				 * until then.
				 */}
				<TooltipIconButton
					label={secret ? "Unmark as secret" : "Mark as secret (masks value in UI)"}
					icon={<KeyRound className="size-icon" />}
					onClick={toggleSecret}
					className={cn(
						"size-control-sm shrink-0 transition-colors",
						secret
							? "text-warning-text hover:text-warning-text hover:bg-warning/10"
							: "text-muted-foreground hover:text-foreground"
					)}
				/>
			</div>
			{/*
			 * The label sits above the control, as `LoadTestConfigDialog` labels its segmented
			 * control: beside it, a narrow popover (a small window's `max-w` clamp) leaves
			 * "Environment Collection Global" nowhere to shrink.
			 */}
			<div className="space-y-1.5">
				<span id={scopeLabelId} className="block text-micro text-muted-foreground">
					Create in
				</span>
				{/*
				 * The app's segmented control (#1391): Radix supplies the `radiogroup`/`radio`
				 * roles, the roving tab stop and the arrows. The Enter handler sits on the group:
				 * the keydown bubbles either way, and the group is a component, not a bare
				 * unfocusable div `jsx-a11y` would need silencing for.
				 */}
				<ToggleGroup
					value={activeScope ?? ""}
					aria-labelledby={scopeLabelId}
					onValueChange={selectScope}
					onKeyDown={(e) => {
						// A focused segment with a value typed leaves Enter nothing else to mean.
						if (isCommitEnter(e)) {
							e.preventDefault();
							create();
						}
					}}
				>
					{scopes.map((scope) => (
						<ToggleGroupItem
							key={scope}
							value={scope}
							/*
							 * Selection follows focus, the radio group pattern: Radix moves the
							 * roving stop and leaves selection to a press, so an arrow would light
							 * one segment while Enter created in another. Focus stays on the
							 * segments, or a second arrow would have nothing to move from.
							 */
							onFocus={() => onSelectedScopeChange(scope)}
						>
							{VARIABLE_SCOPE_CONFIG[scope].full}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
			{/*
			 * The primary action sits where the resolved branch puts Cancel and Save, so both
			 * branches read as one component and the button pushes no row past the card's edge.
			 */}
			<div className="flex justify-end gap-2">
				<Button size="sm" disabled={!canSubmit} onClick={create}>
					Create
				</Button>
			</div>
			{/*
			 * A create offer must not imply the token is unanswered: the row carries a column the
			 * contract does not, so the painter did not divert this token and the send resolves it
			 * anyway. Creating is still worth it, for sends that carry no row.
			 */}
			{boundRowOrigin && (
				<p className="text-micro text-muted-foreground">
					The bound row already answers this name with{" "}
					<span className="font-mono">{boundRowOrigin.value || "empty"}</span>. A variable
					created here answers a send that carries no row.
				</p>
			)}
			{/*
			 * The offer says what it is doing (#1083). A switch would answer better, but this
			 * popover writes values through `onValueChange`, which carries no enabled flag, so the
			 * toggle lives in the variables editor; offering to create in silence is what misleads.
			 */}
			{switchedOffCount > 0 && (
				<p className="text-micro text-muted-foreground">
					{switchedOffCount === 1
						? "This name is already defined below, switched off."
						: `This name is already defined ${switchedOffCount} times below, every one switched off.`}{" "}
					Creating here writes it switched on in the scope you pick, replacing a
					switched-off definition there.
				</p>
			)}
		</>
	);
}

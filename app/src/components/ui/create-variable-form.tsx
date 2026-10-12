/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The undefined branch of `VariablePopover`: a value, a scope to create it in,
 * and Create.
 *
 * The value and the picked scope are held by the popover, not here: its content
 * unmounts on close, the value is the same buffer the close path reads, and a
 * scope picked once survives a re-open of the same token.
 */

import { useId, useRef } from "react";
import type { VariableOrigin } from "@/types";
import { VARIABLE_SCOPE_CONFIG } from "@/constants/variables";
import { isCommitEnter } from "@/lib/keyboard";
import { Button } from "./button";
import { Input } from "./input";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import type { VariableScope } from "./variable-scope-badge";

export interface CreateVariableFormProps {
	name: string;
	/** The scopes a create can be written to, highest precedence first. Never empty. */
	scopes: VariableScope[];
	/** The user's pick; `null`, or a scope no longer writable, means the first. */
	selectedScope: VariableScope | null;
	onSelectedScopeChange: (scope: VariableScope) => void;
	value: string;
	onValueChange: (value: string) => void;
	/** Called only with a non-empty value. */
	onCreate: (scope: VariableScope) => void;
	/**
	 * A real DOM attribute, so it fires on mount whatever Radix's own
	 * `onOpenAutoFocus` decided: an inert (hover) open must pass false.
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
	value,
	onValueChange,
	onCreate,
	autoFocus,
	boundRowOrigin,
	switchedOffCount,
}: CreateVariableFormProps) {
	// Falls back rather than storing a default, so a scope that stops being
	// writable (the environment was deselected) cannot leave a stale selection
	// pointing at a no-op.
	const activeScope = selectedScope && scopes.includes(selectedScope) ? selectedScope : scopes[0];
	const valueRef = useRef<HTMLInputElement>(null);
	const scopeLabelId = useId();

	/**
	 * An empty field is not a variable worth writing (issue #1380).
	 *
	 * `mergeVariable` stores what it is handed, so an empty value defines the name
	 * as `""` - a definition that resolves, so the token stops reading as
	 * undefined and answers with nothing. Refused rather than trimmed: a value of
	 * spaces is a value the user typed, and this form is not the place to have an
	 * opinion about it.
	 */
	const canSubmit = value.length > 0;

	const create = () => {
		if (!activeScope || !canSubmit) return;
		onCreate(activeScope);
	};

	/**
	 * Picking a scope is a modifier on the value, not a destination (issue #1380).
	 *
	 * A segment is a `<button>`, so clicking one takes focus the way any button
	 * does, and the field's `autoFocus` only ever ran at mount - so the click
	 * hands focus back to the value it qualifies.
	 *
	 * Radix clears the value when the active segment is pressed again; a scope has
	 * no "off", so the empty string means "keep what is chosen" and only the
	 * refocus is left to do.
	 */
	const selectScope = (next: string) => {
		const scope = scopes.find((s) => s === next);
		if (scope) onSelectedScopeChange(scope);
		valueRef.current?.focus();
	};

	return (
		<>
			<Input
				size="sm"
				ref={valueRef}
				value={value}
				onChange={(e) => onValueChange(e.target.value)}
				onKeyDown={(e) => {
					// `isCommitEnter`, not a bare Enter (#939): an IME
					// commits its composition with the same keydown, and
					// the app's Send chord is Ctrl/Cmd+Enter.
					if (isCommitEnter(e)) {
						e.preventDefault();
						create();
					}
				}}
				placeholder="value…"
				className="font-mono text-sm"
				aria-label={`Value for new variable ${name}`}
				autoFocus={autoFocus}
			/>
			{/*
			 * The label sits above the control, not beside it, which is how
			 * `LoadTestConfigDialog` labels its own segmented control: beside it,
			 * a narrow popover (a small window's `max-w` clamp) leaves
			 * "Environment Collection Global" nowhere to shrink to.
			 */}
			<div className="space-y-1.5">
				<span id={scopeLabelId} className="block text-micro text-muted-foreground">
					Create in
				</span>
				{/*
				 * The app's segmented control (issue #1391): Radix supplies the
				 * `radiogroup`/`radio` roles, the roving tab stop and the arrow keys.
				 *
				 * The Enter handler sits on the group rather than on each segment:
				 * the keydown bubbles either way, and the group is a component
				 * here, not the bare unfocusable div that `jsx-a11y` would ask to
				 * be silenced about at the line.
				 */}
				<ToggleGroup
					value={activeScope ?? ""}
					aria-labelledby={scopeLabelId}
					onValueChange={selectScope}
					onKeyDown={(e) => {
						// A segment that has focus and a value already
						// typed leaves Enter nothing else to mean.
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
							 * Selection follows focus, which is the radio group's own
							 * pattern: Radix moves the roving tab stop and leaves
							 * selection to a press, so an arrow would otherwise light
							 * one segment while Enter created in another. Focus stays
							 * on the segments rather than returning to the field, or
							 * the second arrow press would have nothing to move from.
							 */
							onFocus={() => onSelectedScopeChange(scope)}
						>
							{VARIABLE_SCOPE_CONFIG[scope].full}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>
			{/*
			 * The primary action sits where the resolved branch puts Cancel and
			 * Save, so the two branches read as one component - and so the button
			 * is not the thing that pushes a row past the card's edge.
			 */}
			<div className="flex justify-end gap-2">
				<Button size="sm" disabled={!canSubmit} onClick={create}>
					Create
				</Button>
			</div>
			{/*
			 * A create offer must not imply the token is unanswered. The row
			 * carries a column the declared contract does not, so the painter never
			 * diverted this token and the send resolves it anyway - creating a
			 * variable here is still worth doing, but for the sends that carry no
			 * row, not for this one.
			 */}
			{boundRowOrigin && (
				<p className="text-micro text-muted-foreground">
					The bound row already answers this name with{" "}
					<span className="font-mono">{boundRowOrigin.value || "empty"}</span>. A variable
					created here answers a send that carries no row.
				</p>
			)}
			{/*
			 * The offer says what it is doing (issue #1083). A switch would be the
			 * closer answer, and this popover cannot give it: it writes values
			 * through `onValueChange`, which carries no enabled flag, so the toggle
			 * lives in the variables editor. Offering to create in silence is the
			 * part that misleads.
			 */}
			{switchedOffCount > 0 && (
				<p className="text-micro text-muted-foreground">
					{switchedOffCount === 1
						? "This name is already defined below, switched off."
						: `This name is already defined ${switchedOffCount} times below, every one switched off.`}{" "}
					Switching one back on answers the token; creating here adds another definition
					and leaves it off.
				</p>
			)}
		</>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One editable variable in the context bar: its name, a marker beside it, and
 * the input its edits are typed into.
 *
 * Shared by the request tab's resolved list and the collection tab's own
 * definitions. The two differ only in the marker - a scope badge on one, an
 * "off" note on the other - and in where the commit lands; everything subtle
 * here (the remount key, the Escape restore, the uncontrolled input a rejected
 * save relies on) is the same act on both, so it is written once.
 */

import { Input, SecretInput } from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import type { ReactNode } from "react";
import type { ResolvedVariable } from "@/types";

interface VariableRowProps {
	name: string;
	/** The definition on screen - the one a commit is allowed to write back to. */
	resolved: ResolvedVariable;
	/** Drawn after the name. The scope badge, or nothing. */
	marker?: ReactNode;
	/** Called on blur and on Enter with the input itself - see `useVariableCommit`. */
	onCommit: (input: HTMLInputElement) => void;
}

export function VariableRow({ name, resolved, marker, onCommit }: VariableRowProps) {
	return (
		<div className="grid grid-cols-2 gap-2 items-center">
			{/* The scope decides where an edit lands, so it is visible
			    rather than hidden in a mouse-only `title`;
			    `VariableScopeBadge` is the primitive the variable popover
			    already uses to say it. */}
			<div className="flex items-center gap-1.5 min-w-0 px-1">
				<TruncatedText className="text-xs font-mono text-foreground">{name}</TruncatedText>
				{marker}
			</div>
			{resolved.secret ? (
				/*
				 * The shared masked field with its eye toggle, not a hand-rolled
				 * `••••••` that can never be looked at (#1308) - a hand-rolled copy of
				 * a primitive does not receive the primitive's fixes. Read-only here:
				 * the request tab shows what resolved, and a secret's edit lands on
				 * the Variables page, so revealing is the whole of what this row adds.
				 * Reveal state lives inside `SecretInput`, so it is keyed by the
				 * definition's identity (name:scope:source, not its value) - an
				 * environment or tab switch remounts it and re-masks, the defect #621
				 * names when reveal is keyed by position.
				 */
				<SecretInput
					key={`${name}:${resolved.scope}:${resolved.sourceId}`}
					value={resolved.value}
					onChange={() => {}}
					readOnly
					aria-label={`Value of ${name}`}
					className="h-7 text-xs"
				/>
			) : (
				<Input
					/*
					 * Scope and source belong in the key, not just the
					 * value. On the value alone, an environment switch
					 * or a Ctrl+N tab switch mid-edit that happens to
					 * resolve the same string kept the DOM node alive
					 * and let the blur write into the *newly* resolved
					 * definition. Including the source remounts the
					 * node instead, so an abandoned edit is dropped -
					 * the lesser outcome, and never a mistargeted one.
					 */
					key={`${name}:${resolved.scope}:${resolved.sourceId}:${resolved.value}`}
					defaultValue={resolved.value}
					aria-label={`Value of ${name}`}
					className="h-7 text-xs font-mono"
					onBlur={(e) => onCommit(e.target)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						} else if (e.key === "Escape") {
							e.currentTarget.value = resolved.value;
							e.currentTarget.blur();
						}
					}}
				/>
			)}
		</div>
	);
}

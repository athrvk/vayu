/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * EditableVariable Component
 *
 * A clickable `{{variable}}` token, inline in a URL or header value.
 * - Hover shows what it resolves to, without opening anything
 * - Click (or Enter/Space) opens VariablePopover to view and edit it
 * - Colour reflects whether the variable resolves at all
 *
 * This is the request-builder half of the pair: `VariablePopover` lives in
 * `components/ui` and takes everything as props, so the context reads that feed
 * it - the other definitions of this name, and the scopes a new one could be
 * written to - happen here.
 */

import {
	VariablePopover,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	TooltipValue,
} from "@/components/ui";
import type { VariableScope } from "@/components/ui";
import { cn } from "@/lib/utils";
// The specific module, not the `../../context` barrel - matching the sibling
// `VariableInput/index.tsx`, whose tests mock this exact path.
import type { VariableScope as RequestBuilderVariableScope, VariableSupport } from "@/types";

export interface EditableVariableProps {
	/** Variable name */
	name: string;
	/** Variable value */
	value: string;
	/** Variable scope */
	scope: RequestBuilderVariableScope;
	/** Whether the variable is resolved (exists) */
	resolved: boolean;
	/** Callback when variable value changes */
	onValueChange?: (name: string, value: string, scope: RequestBuilderVariableScope) => void;
	/** Whether editing is disabled */
	disabled?: boolean;
	/** True when the value is a secret, so hover must not print it. */
	secret?: boolean;
	/** The environment or collection it came from. Absent for globals. */
	sourceName?: string;
	/**
	 * The scope this token belongs to. Required, not optional as it is further
	 * up: a token only renders where there *is* a scope, so the popover always
	 * has origins to list and writable targets to offer (#564).
	 */
	variables: VariableSupport;
	/**
	 * Position in the host field's roving tab order (issue #1215). `VariableInput`
	 * paints a strip of these over one input and gives exactly one of them the
	 * Tab stop, so a URL with five variables costs one stop rather than five.
	 * Left at `0` for a token rendered on its own.
	 */
	tabIndex?: number;
}

export default function EditableVariable({
	name,
	value,
	scope,
	resolved,
	onValueChange,
	disabled = false,
	secret = false,
	sourceName,
	variables,
	tabIndex,
}: EditableVariableProps) {
	const { getVariableOrigins, writableScopes } = variables;
	const origins = getVariableOrigins(name);

	const varInfo = resolved ? { value, scope: scope as VariableScope, secret, sourceName } : null;

	/**
	 * The bound row's answer, if it has one (issue #1064).
	 *
	 * Hovering reads and clicking edits, so the two must not read differently:
	 * once the popover names the row as the origin, a tooltip still printing the
	 * environment's value makes the same token say two things about one send.
	 * Taken off the origins this component already fetches rather than through a
	 * prop of its own, so there is one answer to "what wins" and not two.
	 */
	const boundRowValue = origins.find((o) => o.scope === "row")?.value;

	const handleValueChange = onValueChange
		? (varName: string, varValue: string, varScope: VariableScope) => {
				onValueChange(varName, varValue, varScope as RequestBuilderVariableScope);
			}
		: undefined;

	/*
	 * `font-[inherit]`, matching the plain-text segments beside it.
	 *
	 * This used to hardcode `ui-monospace, SFMono-Regular, 'SF Mono', Menlo,
	 * Consolas, 'Liberation Mono', monospace` under a comment saying "same
	 * monospace font as input for consistent character widths" - and that stack
	 * does not contain the app's mono font. `--font-mono` is `"JetBrains Mono",
	 * "Consolas", "Monaco", monospace`, so a variable token rendered in a
	 * different typeface from the text either side of it.
	 *
	 * That matters beyond looks. `VariableInput` paints this overlay on top of a
	 * transparent <input>, and the caret the user steers by belongs to the input.
	 * Any width difference between the two fonts walks the caret away from the
	 * glyphs it appears to sit between - which is exactly the drift the comment
	 * was trying to prevent.
	 */
	const token = (
		<span className="font-[inherit]" contentEditable={false} suppressContentEditableWarning>
			{`{{${name}}}`}
		</span>
	);

	return (
		<VariablePopover
			tabIndex={tabIndex}
			name={name}
			varInfo={varInfo}
			resolved={resolved}
			onValueChange={handleValueChange}
			saveMode="auto"
			disabled={disabled}
			origins={origins}
			writableScopes={writableScopes}
			trigger={
				/*
				 * Hovering reads, clicking edits.
				 *
				 * Most token clicks are only ever to *see* what a variable resolves
				 * to, and a click commits you to a popover you then have to dismiss.
				 * The tooltip answers that without one, which makes a URL full of
				 * variables readable by sweeping across it.
				 *
				 * A secret shows dots and never its value: the popover gates that
				 * behind a deliberate reveal, and a tooltip printing it on mouseover
				 * would walk straight around the gate.
				 *
				 * Radix closes a tooltip on pointerdown and on blur, so opening the
				 * popover - by click, or by Enter, which moves focus into it - takes
				 * the tooltip down rather than stacking the two.
				 */
				<Tooltip>
					<TooltipTrigger asChild>{token}</TooltipTrigger>
					{/*
					 * Everything in here is a tint of `--primary-foreground`, not a
					 * semantic token. `TooltipContent` paints `bg-primary-fill` and
					 * carries a white label, so `text-muted-foreground` would be
					 * near-invisible on it and `text-destructive-text` - a dark rose
					 * tuned for a light card - would be worse. The token itself is
					 * already red when unresolved; the tooltip only has to say so.
					 */}
					<TooltipContent side="bottom" className="max-w-xs">
						{boundRowValue !== undefined ? (
							/*
							 * The row outranks every scope, so it is the answer whether or
							 * not one of them also defines the name - which makes this the
							 * first branch rather than a case inside the resolved one. A
							 * cell is never a secret: it came from the picked file, not
							 * from a stored variable someone marked.
							 */
							<TooltipValue className="font-mono" hint="Bound row">
								{boundRowValue || "empty"}
							</TooltipValue>
						) : !resolved ? (
							<span className="italic opacity-90">not defined</span>
						) : (
							/*
							 * A secret says it *is* a secret rather than drawing a row
							 * of dots. Dots on hover are the worst of both: they occupy
							 * the space of an answer, tell you nothing you did not
							 * already know from the token, and invite a second look to
							 * check you did not misread them. The word plus the source
							 * is the useful part - whether it is set at all belongs in
							 * the popover, where revealing is a deliberate act.
							 */
							<TooltipValue
								className={secret ? "italic opacity-90" : "font-mono"}
								hint={sourceName}
							>
								{secret ? "secret" : value || "empty"}
							</TooltipValue>
						)}
					</TooltipContent>
				</Tooltip>
			}
			triggerClassName={cn(
				"inline cursor-pointer transition-colors rounded-md",
				!resolved
					? "text-destructive-text hover:bg-destructive-text/10"
					: !value
						? "text-muted-foreground hover:bg-muted"
						: "text-primary hover:bg-primary/10",
				disabled && "cursor-default opacity-50"
			)}
		/>
	);
}

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "What does this `{{name}}` resolve to?" in an editor, answered by the same
 * card that answers it in a field (issue #1320).
 *
 * The editors used to answer through Monaco's own hover widget, fed markdown:
 * the token as a code chip, the value as a second one, the source in italics.
 * Monaco renders that in VS Code's palette, so one token had two designs - the
 * app's `TooltipValue` over a URL bar, a grey-chipped `vs-dark` card three
 * lines below it in the body. This is the app's tooltip, over the rectangle the
 * editor measured, which is exactly how `VariablePopover` already reaches a
 * token that has no DOM node of its own.
 *
 * **What it says is the field tooltip's three lines and no more** (`Editable-
 * Variable`): what the send will use, and where that came from. The list of
 * definitions that lost stays in the popover, one ⌘-click away, where it was
 * already drawn and where there is room to strike them through.
 */

import { Tooltip, TooltipContent, TooltipTrigger, TooltipValue } from "@/components/ui";
import type { VariableTokenKind } from "@/lib/variable-token-kind";
import type { VariableOrigin } from "@/types";
import type { TokenHoverRequest } from "./context";

/**
 * The value line and the hint under it, for a classified token.
 *
 * The branches are `EditableVariable`'s, in its order and its wording - a
 * bound row above every scope, a secret as the word rather than its value or a
 * row of dots, `empty` for a definition that resolves to nothing. Two surfaces
 * answering one token differently is the defect this whole layer exists to
 * avoid; two spellings of the same answer is the same defect, smaller.
 */
function HoverAnswer({ kind, origins }: { kind: VariableTokenKind; origins: VariableOrigin[] }) {
	const boundRow = origins.find((origin) => origin.scope === "row");
	if (boundRow) {
		return (
			<TooltipValue className="font-mono" hint="Bound row">
				{boundRow.value || "empty"}
			</TooltipValue>
		);
	}
	if (kind.state === "runtime") {
		return <TooltipValue hint={kind.note}>{kind.description}</TooltipValue>;
	}
	if (kind.state === "undefined") {
		return <span className="italic opacity-90">not defined</span>;
	}
	const info = kind.info;
	return (
		<TooltipValue
			className={info?.secret ? "italic opacity-90" : "font-mono"}
			hint={info?.sourceName}
		>
			{info?.secret ? "secret" : info?.value || "empty"}
		</TooltipValue>
	);
}

export function TokenHoverCard({
	request,
	kind,
	origins,
}: {
	request: TokenHoverRequest;
	kind: VariableTokenKind;
	origins: VariableOrigin[];
}) {
	return (
		<div
			// Fixed and inert, for the same reason the popover's anchor is: the
			// rectangle came from `getBoundingClientRect` on the editor, and a box
			// over Monaco's canvas that took the pointer would end the hover it was
			// drawn for - and swallow the ⌘-click that opens the popover.
			style={{
				position: "fixed",
				left: request.rect.left,
				top: request.rect.top,
				width: request.rect.width,
				height: request.rect.height,
				pointerEvents: "none",
			}}
		>
			{/*
			 * Open because it is mounted: the editor owns the timing (it holds the
			 * pointer), so this component exists only while the tooltip should be
			 * up. Radix's own open delay would run a second timer after that one.
			 */}
			<Tooltip open>
				<TooltipTrigger asChild>
					{/*
					 * Never a Tab stop - the keyboard reads a token by opening its
					 * popover (⇧⌘D), which says everything this card does and more.
					 * It still carries the token's text, so the tooltip Radix points
					 * at it with `aria-describedby` describes something named.
					 */}
					<span className="block h-full w-full" tabIndex={-1}>
						<span className="sr-only">{`{{${request.name}}}`}</span>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="max-w-xs">
					<HoverAnswer kind={kind} origins={origins} />
				</TooltipContent>
			</Tooltip>
		</div>
	);
}

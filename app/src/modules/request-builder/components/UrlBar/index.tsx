/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UrlBar Component
 *
 * One row: the method and URL as a single field, then Send and Load Test as one
 * attached pair.
 *
 * **Three controls became two.** The method was a separate `w-[76px]` dropdown,
 * sized for OPTIONS and therefore wasting ~40px on every GET, and it cost the
 * row an extra border and an extra gap on top of that. It now sits inside the
 * URL field's own border, which is where it belongs - the verb and the address
 * are one thought, and a browser puts its protocol chip in the same place.
 *
 * **Send and Load Test are attached rather than adjacent.** They were two
 * separate buttons at two different type sizes (13px and 12px), which is the
 * signature of two controls styled at different times rather than a pair
 * designed together. Joining a filled button to an outlined one usually reads
 * as a seam between two materials; it works here because both members are on
 * the same accent - Send takes `--primary-fill` with a white label, Load Test
 * takes `--primary` at 12% with `--primary-text` - so the join is a step in
 * weight inside one colour. The shared edge is Load Test's own border with a
 * transparent left, which keeps both heights identical without a doubled line.
 *
 * **Both shortcuts are now real, and both are on hover.** Send has always been
 * Cmd/Ctrl+Enter and said so nowhere; Load Test had none. They come from
 * `constants/shortcuts.ts`, so the label and the handler cannot disagree.
 *
 * **No icons and no inline keycaps.** Both were tried and both cost width in
 * the one row that has none to spare: the lightning bolt and the triangle each
 * added ~20px, and `Ctrl+Shift+↵` as a cap added ~70px to a nine-character
 * label. The pair is ~140px now against ~186px before, and a tooltip carries
 * the chord for free. The running state keeps a single pulsing dot, because a
 * live run is the one thing here that a static colour cannot say.
 */

import { useRequestBuilderContext } from "../../context";
import { useDashboardStore, useTabsStore } from "@/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { formatChord, type Chord } from "@/lib/platform";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import { cn } from "@/lib/utils";
import MethodSelector from "./MethodSelector";
import UrlInput from "./UrlInput";

/**
 * A button plus the shortcut that fires it, on hover.
 *
 * The chord was tried *inside* the buttons first, as a keycap, and it made them
 * far too wide - `Ctrl+Shift+↵` is eleven characters riding a label of nine, in
 * a row whose whole complaint is that the URL does not get enough of it. A
 * tooltip costs zero width and is where a shortcut conventionally lives.
 *
 * The `Kbd` primitive is not used for the chord here either: it is a keycap
 * built for `--muted` on a panel, and `TooltipContent` paints `--primary-fill`
 * with a white label, so a cap would be a grey chip stamped on the accent.
 * Plain mono at reduced opacity reads correctly on that fill.
 */
function Hint({
	chord,
	label,
	children,
}: {
	chord: Chord;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="bottom" className="flex items-center gap-2">
				<span>{label}</span>
				<span className="font-mono opacity-70">{formatChord(chord)}</span>
			</TooltipContent>
		</Tooltip>
	);
}

export default function UrlBar() {
	const { request, isExecuting, executeRequest, startLoadTest, canStartLoadTest } =
		useRequestBuilderContext();
	const isLoadTestRunning = useDashboardStore((s) => s.isStreaming);
	const openTab = useTabsStore((s) => s.openTab);

	const canExecute = !isExecuting && request.url.trim().length > 0;
	const viewRunningTest = () => openTab({ type: "dashboard", entityId: null });

	/*
	 * Send owns both outer corners when it is alone in the group.
	 *
	 * `canStartLoadTest` is false for a detached copy of a past design run, so
	 * the second member is absent entirely - and an attached group whose only
	 * member keeps a squared-off right edge looks broken rather than deliberate.
	 * This is the state most likely to be missed, which is why the existing
	 * guard in UrlBar.test.tsx covers it.
	 */
	const sendAlone = !canStartLoadTest;

	return (
		<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-panel shrink-0">
			{/*
			    One field holding both the method and the URL.
			    `border-input`, not `border-border`. This is a text field, and
			    `--input` exists precisely so a field has an edge - measured in the
			    running app, `--border` on `--card` is **1.003**, meaning the
			    most-used control in Vayu had no visible boundary in dark mode
			    beyond the card-on-panel step, which is itself only 1.09.
			 */}
			<div
				className={cn(
					// `bg-card surface-card`, the pair. `surface-card` sets the
					// background *and* declares the `--rule` that reads on it, but a
					// `bg-*` utility beside it wins the cascade - so both are written,
					// per docs/design-system.md. The separator below inherits `--rule`
					// from here.
					"flex flex-1 min-w-0 items-center h-[34px] rounded-md bg-card surface-card",
					"border border-input transition-colors focus-within:border-primary"
				)}
			>
				<MethodSelector />
				{/*
				    The hairline between the two halves of the field.
				    `border-rule`, not `bg-border`. This rule sits on `--card`, and
				    `--border` *is* `--card` in dark - measured 1.01, i.e. absent -
				    while reading 1.30 in light. That asymmetry is exactly the defect
				    the surface/rule contract exists to remove: `surface-card` above
				    resolves `--rule` to `--border` in light and `--border-strong` in
				    dark, so this lands at 1.30 / 1.27 instead of 1.30 / 1.01.

				    `h-5`, not full height: a full-height rule would read as a wall
				    between two controls, which is what this stopped being.
				 */}
				<span aria-hidden="true" className="h-5 w-0 shrink-0 border-l border-rule" />
				<UrlInput className="flex-1 min-w-0 h-full border-0 bg-transparent px-3 text-sm font-mono shadow-none rounded-none focus-within:ring-0" />
			</div>

			{/* Send + Load Test, attached. The corner rules are spelled per member
			    rather than on the group, because the group has a one-member state
			    and the rules differ between them. */}
			<div className="flex shrink-0">
				<Hint chord={SEND_CHORD} label="Send request">
					<button
						onClick={executeRequest}
						disabled={!canExecute}
						className={cn(
							"h-[34px] px-4 inline-flex items-center gap-1.5 shrink-0",
							"bg-primary-fill text-white text-xs font-semibold font-[inherit]",
							"border border-primary-fill",
							/*
							 * There was no hover state at all. `hover:bg-primary-fill/90` is
							 * the `Button` primitive's own `default` variant - these are
							 * hand-rolled so the pair can share an edge, which means they
							 * carry the convention rather than inherit it. The border moves
							 * with the fill, or a lighter ring appears around a darkening
							 * button.
							 */
							"hover:bg-primary-fill/90 hover:border-primary-fill/90",
							"disabled:opacity-50 disabled:hover:bg-primary-fill transition-colors",
							sendAlone ? "rounded-md" : "rounded-l-md rounded-r-none"
						)}
					>
						{isExecuting ? (
							<>
								<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-[vayu-spin_0.7s_linear_infinite] inline-block" />
								Sending
							</>
						) : (
							"Send"
						)}
					</button>
				</Hint>

				{/* Hidden entirely when the builder cannot load test - a detached copy
				    of a past design run has no load-test handler, so showing the
				    button (or a disabled one) would only mislead. */}
				{canStartLoadTest &&
					(isLoadTestRunning ? (
						/* While a run is live this becomes a shortcut to the running
						   dashboard (single-active-run policy), on the status tokens
						   rather than the accent - it is reporting a state, not
						   offering the same action, and the colour is what says so
						   now that the icon is gone. */
						<button
							onClick={viewRunningTest}
							className={cn(
								"h-[34px] px-3.5 inline-flex items-center gap-1.5 shrink-0",
								"text-xs font-semibold font-[inherit] transition-colors",
								"text-status-success-text bg-status-success/10 hover:bg-status-success/20",
								"border border-status-success/40 border-l-transparent",
								"rounded-r-md rounded-l-none"
							)}
						>
							{/* The one mark kept: a run is *live*, and a static green
							    tint alone does not say so. */}
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-status-success animate-pulse"
							/>
							View running test
						</button>
					) : (
						<Hint chord={LOAD_TEST_CHORD} label="Start a load test">
							<button
								onClick={startLoadTest}
								disabled={!canExecute}
								className={cn(
									"h-[34px] px-4 inline-flex items-center shrink-0",
									"text-xs font-semibold font-[inherit]",
									// A tint steps *up* rather than down: /10 to /20 is the same
									// "one more step of itself" that /90 gives the solid fill.
									"text-primary-text bg-primary/10 hover:bg-primary/20",
									// The join: this member's own border, with the shared
									// edge transparent. Two adjacent 1px borders would draw
									// a 2px line and make the pair a pixel taller than Send.
									"border border-primary/45 border-l-transparent",
									"rounded-r-md rounded-l-none",
									"disabled:opacity-50 disabled:hover:bg-primary/10 transition-colors"
								)}
							>
								Load Test
							</button>
						</Hint>
					))}
			</div>
		</div>
	);
}

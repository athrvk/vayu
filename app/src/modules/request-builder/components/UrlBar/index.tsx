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
 * **Both shortcuts are now real and both are visible.** Send has always been
 * Cmd/Ctrl+Enter and said so nowhere; Load Test had none. They come from
 * `constants/shortcuts.ts`, so the label and the handler cannot disagree.
 */

import { Zap, Activity } from "lucide-react";
import { useRequestBuilderContext } from "../../context";
import { useDashboardStore, useTabsStore } from "@/stores";
import { formatChord } from "@/lib/platform";
import { SEND_CHORD, LOAD_TEST_CHORD } from "@/constants/shortcuts";
import { cn } from "@/lib/utils";
import MethodSelector from "./MethodSelector";
import UrlInput from "./UrlInput";

/**
 * The shortcut hint riding inside a button.
 *
 * **Not the `Kbd` primitive**, which is checked for and deliberately not used
 * here. `Kbd` is a keycap - `bg-muted` with `text-foreground` and a
 * `border-border-strong` bottom edge - built to sit on a panel or a card. Inside
 * a `--primary-fill` button carrying a white label it would render as a grey
 * chip with dark text stamped on the accent, which is worse than no hint.
 *
 * So this is a dimmed inline glyph instead: a footnote on the label, in the
 * label's own colour. On `--primary-fill` there is no second colour available
 * that is neither the white it already uses nor unreadable.
 */
function Kbd({ children, className }: { children: string; className?: string }) {
	return (
		<kbd
			aria-hidden="true"
			className={cn("font-mono text-[10px] font-normal opacity-70", className)}
		>
			{children}
		</kbd>
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
					"flex flex-1 min-w-0 items-center h-[34px] rounded-md bg-card",
					"border border-input transition-colors focus-within:border-primary"
				)}
			>
				<MethodSelector />
				{/* Hairline between the two halves of the field. `h-5`, not full
				    height: a full-height rule would read as a wall between two
				    controls, which is what this stopped being. */}
				<span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
				<UrlInput className="flex-1 min-w-0 h-full border-0 bg-transparent px-3 text-sm font-mono shadow-none rounded-none focus-within:ring-0" />
			</div>

			{/* Send + Load Test, attached. `[&>*:not(:first-child)]:rounded-l-none`
			    style rules are spelled per member below rather than on the group,
			    because the group has a one-member state and the rules differ. */}
			<div className="flex shrink-0">
				<button
					onClick={executeRequest}
					disabled={!canExecute}
					className={cn(
						"h-[34px] px-3.5 inline-flex items-center gap-1.5 shrink-0",
						"bg-primary-fill text-white text-xs font-semibold font-[inherit]",
						"border border-primary-fill",
						"disabled:opacity-50 transition-opacity",
						sendAlone ? "rounded-md" : "rounded-l-md rounded-r-none"
					)}
				>
					{isExecuting ? (
						<>
							<span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-[vayu-spin_0.7s_linear_infinite] inline-block" />
							Sending
						</>
					) : (
						<>
							{/*
							 * The triangle is decoration, but it is a text node, so it
							 * lands in the button's accessible name - screen readers
							 * announce U+25B6 by its Unicode name before the word
							 * "Send". Hidden rather than removed: it is doing visual
							 * work in a bar of otherwise identical-looking buttons.
							 */}
							<span aria-hidden="true">▶</span> Send
							<Kbd>{formatChord(SEND_CHORD)}</Kbd>
						</>
					)}
				</button>

				{/* Hidden entirely when the builder cannot load test - a detached copy
				    of a past design run has no load-test handler, so showing the
				    button (or a disabled one) would only mislead. */}
				{canStartLoadTest &&
					(isLoadTestRunning ? (
						/* While a run is live this becomes a shortcut to the running
						   dashboard (single-active-run policy), on the status tokens
						   rather than the accent - it is reporting a state, not
						   offering the same action. */
						<button
							onClick={viewRunningTest}
							className={cn(
								"h-[34px] px-3 inline-flex items-center gap-1.5 shrink-0",
								"text-xs font-semibold font-[inherit] transition-opacity",
								"text-status-success-text bg-status-success/10",
								"border border-status-success/40 border-l-transparent",
								"rounded-r-md rounded-l-none"
							)}
						>
							<Activity className="w-3.5 h-3.5" />
							View running test
						</button>
					) : (
						<button
							onClick={startLoadTest}
							disabled={!canExecute}
							className={cn(
								"h-[34px] px-3 inline-flex items-center gap-1.5 shrink-0",
								"text-xs font-semibold font-[inherit]",
								"text-primary-text bg-primary/10",
								// The join: this member's own border, with the shared
								// edge transparent. Two adjacent 1px borders would draw
								// a 2px line and make the pair a pixel taller than Send.
								"border border-primary/45 border-l-transparent",
								"rounded-r-md rounded-l-none",
								"disabled:opacity-50 transition-opacity"
							)}
						>
							<Zap className="w-3.5 h-3.5" />
							Load Test
							<Kbd>{formatChord(LOAD_TEST_CHORD)}</Kbd>
						</button>
					))}
			</div>
		</div>
	);
}

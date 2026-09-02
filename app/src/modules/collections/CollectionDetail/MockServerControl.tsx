/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Start and stop a mock server for the collection on screen (issue #481 phase 2).
 *
 * This is the *contextual* starter: a mock needs a collection, and this header
 * is the one surface that already has one. The Services drawer owns the list of
 * everything running and can stop any of them, but it has no collection to
 * start one from - which is why the group there has no "New mock" affordance
 * and this control exists instead.
 *
 * A mock's route table is a snapshot taken at start, so there is nothing to
 * "restart" - stopping and starting again is the only way to pick up an edit,
 * and saying so in the tooltip is cheaper than a restart button that hides it.
 *
 * The button starts directly and the options dialog sits beside it (issue
 * #570). A dialog on the way in would make the common case - serve this
 * collection with nothing set - two clicks to serve the uncommon one, which is
 * the wrong trade and the one the acceptance criteria pin: latency and error
 * rate are for the load run you point at the mock, not for poking a route by
 * hand. `NewIssuerDialog` has no equivalent split because an issuer has no
 * defaults-only case worth one click.
 */

import { Copy, Play, ServerCog, SlidersHorizontal, Square } from "lucide-react";
import { useState } from "react";
import { Button, TooltipIconButton } from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import {
	useMockServersQuery,
	useStartMockServerMutation,
	useStopMockServerMutation,
} from "@/queries";
import { useToastStore } from "@/stores";
import { useCopy } from "@/hooks";
import { mockForCollection } from "./mock-server-selection";
import { StartMockServerDialog } from "./StartMockServerDialog";
import type { MockServerOptions } from "./mock-server-options";

export default function MockServerControl({ collectionId }: { collectionId: string }) {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const mocksQuery = useMockServersQuery();
	const startMock = useStartMockServerMutation();
	const stopMock = useStopMockServerMutation();
	const [optionsOpen, setOptionsOpen] = useState(false);

	const running = mockForCollection(mocksQuery.data ?? [], collectionId);

	/**
	 * Without @p options the payload is `{ collectionId }` alone, exactly as it
	 * was before the dialog existed - the engine's own defaults rather than this
	 * surface restating them.
	 */
	const start = (options?: MockServerOptions) =>
		startMock.mutate(
			{ collectionId, ...options },
			{
				onSuccess: (mock) => {
					setOptionsOpen(false);
					showToast(
						`Mock server on port ${mock.port} - ${mock.routeCount} route${
							mock.routeCount === 1 ? "" : "s"
						}`,
						"success"
					);
				},
				// The engine refuses a collection with no requests and one whose
				// requests it cannot fit, and both messages name the reason. A
				// generic fallback would turn "nothing to serve" into "could not
				// start", which is the half that is not actionable.
				//
				// From the dialog the same message is a Callout in the form, so
				// there is no toast: the dialog stays open on a failure, and a
				// toast behind it would report it twice and lose it once.
				onError: (error) => {
					if (options) return;
					showToast(
						error instanceof Error ? error.message : "Could not start the mock server",
						"error"
					);
				},
			}
		);

	if (!running) {
		return (
			<div className="flex items-center gap-1">
				<Button
					variant="outline"
					size="sm"
					onClick={() => start()}
					disabled={startMock.isPending}
				>
					<Play className="h-3.5 w-3.5" aria-hidden="true" />
					Run mock server
				</Button>
				<TooltipIconButton
					label="Mock server options"
					tooltipHint="Latency and error rate"
					icon={<SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />}
					disabled={startMock.isPending}
					// The mutation outlives the dialog, so a failed direct start
					// would greet the next open with a Callout about it.
					onClick={() => {
						startMock.reset();
						setOptionsOpen(true);
					}}
				/>
				{optionsOpen && (
					<StartMockServerDialog
						onOpenChange={setOptionsOpen}
						onStart={start}
						pending={startMock.isPending}
						error={startMock.error}
					/>
				)}
			</div>
		);
	}

	return (
		<div className="flex min-w-0 items-center gap-1">
			{/* A chip, not a button: the URL is the value you copy, and the two
			    controls beside it are the actions. `surface-sunken` declares the
			    `--rule` the border reads - a bare border token is invisible on
			    the panel this header sits on. */}
			<span className="surface-sunken flex min-w-0 items-center gap-1.5 rounded-md border border-rule px-2 py-1">
				{/* A server that is up is a run state, so the glyph takes the
				    `--status-*` family's text pair - the bare indicator token
				    misses even the 3:1 icon bar on a light surface (2.20:1). */}
				<ServerCog
					className="h-3.5 w-3.5 shrink-0 text-status-success-text"
					aria-hidden="true"
				/>
				<TruncatedText className="font-mono text-xs">{running.url}</TruncatedText>
				<span className="shrink-0 text-xs text-muted-foreground">
					{running.routeCount} route{running.routeCount === 1 ? "" : "s"}
					{running.routesWithoutExample > 0 &&
						`, ${running.routesWithoutExample} without an example`}
				</span>
			</span>
			<TooltipIconButton
				label="Copy mock server URL"
				tooltipHint={running.url}
				icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
				onClick={() => void copy(running.url, "Mock server URL")}
			/>
			<TooltipIconButton
				label={`Stop mock server on port ${running.port}`}
				tooltipHint="A mock keeps the collection, latency and error rate it started with - stop and start it again to change any of them"
				icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
				disabled={stopMock.isPending}
				onClick={() =>
					stopMock.mutate(running.mockId, {
						onError: (error) =>
							showToast(
								error instanceof Error
									? error.message
									: "Could not stop the mock server",
								"error"
							),
					})
				}
			/>
		</div>
	);
}

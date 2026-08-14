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
 */

import { Copy, Play, ServerCog, Square } from "lucide-react";
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

export default function MockServerControl({ collectionId }: { collectionId: string }) {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const mocksQuery = useMockServersQuery();
	const startMock = useStartMockServerMutation();
	const stopMock = useStopMockServerMutation();

	const running = mockForCollection(mocksQuery.data ?? [], collectionId);

	const start = () =>
		startMock.mutate(
			{ collectionId },
			{
				onSuccess: (mock) =>
					showToast(
						`Mock server on port ${mock.port} - ${mock.routeCount} route${
							mock.routeCount === 1 ? "" : "s"
						}`,
						"success"
					),
				// The engine refuses a collection with no requests and one whose
				// requests it cannot fit, and both messages name the reason. A
				// generic fallback would turn "nothing to serve" into "could not
				// start", which is the half that is not actionable.
				onError: (error) =>
					showToast(
						error instanceof Error ? error.message : "Could not start the mock server",
						"error"
					),
			}
		);

	if (!running) {
		return (
			<Button variant="outline" size="sm" onClick={start} disabled={startMock.isPending}>
				<Play className="h-3.5 w-3.5" aria-hidden="true" />
				Run mock server
			</Button>
		);
	}

	return (
		<div className="flex min-w-0 items-center gap-1">
			{/* A chip, not a button: the URL is the value you copy, and the two
			    controls beside it are the actions. `surface-sunken` declares the
			    `--rule` the border reads - a bare border token is invisible on
			    the panel this header sits on. */}
			<span className="surface-sunken flex min-w-0 items-center gap-1.5 rounded-md border border-rule px-2 py-1">
				<ServerCog className="h-3.5 w-3.5 shrink-0 text-success-text" aria-hidden="true" />
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
				tooltipHint="A mock serves the collection as it was when it started - stop and start it again to pick up an edit"
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

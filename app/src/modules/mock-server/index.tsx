/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Mock Server (issue #481 phase 3)
 *
 * The Services drawer's Mock servers row used to expand in place to show the
 * route table - fine while a route table was the only thing there was to see.
 * Once a mock also keeps a live activity log, it needs the width the inbox
 * tab already claimed for the same reason: a list that grows while you watch
 * it does not fit a drawer.
 *
 * One tab, not one per mock, on the same precedent `inbox`'s module doc
 * gives: a mock is engine-process state with no id worth restoring across a
 * restart, and the tab's own `entityId` is the address a drawer row or this
 * view's own switcher writes - never mirrored into local state.
 */

import { Copy, Radio as MockIcon, Square } from "lucide-react";
import {
	Badge,
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import { EmptyState, ErrorState, TruncatedText } from "@/components/shared";
import {
	useMockActivityQuery,
	useMockServerRoutesQuery,
	useMockServersQuery,
	useStopMockServerMutation,
} from "@/queries";
import { useTabsStore, useToastStore } from "@/stores";
import { useCopy } from "@/hooks";
import { formatTime } from "@/lib/format-time";

export default function MockServerView() {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const { openTabs, activeTabId, openTab } = useTabsStore();
	const { data: mocks = [], isError, error, refetch } = useMockServersQuery();
	const stopMock = useStopMockServerMutation();

	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const addressedMockId = activeTab?.type === "mock-server" ? activeTab.entityId : null;
	const show = (mockId: string) => openTab({ type: "mock-server", entityId: mockId });

	const ordered = [...mocks].sort((a, b) => a.port - b.port);
	const mock = mocks.find((m) => m.mockId === addressedMockId) ?? ordered[0] ?? null;

	const routesQuery = useMockServerRoutesQuery(mock?.mockId ?? null);
	const routes = routesQuery.data ?? [];
	const activityQuery = useMockActivityQuery(mock?.mockId ?? null);
	const activity = activityQuery.data ?? [];

	if (isError) {
		return (
			<ErrorState
				title="Couldn't load the mock servers"
				detail={error instanceof Error ? error.message : undefined}
				onRetry={() => void refetch()}
			/>
		);
	}

	if (!mock) {
		return (
			<EmptyState
				icon={MockIcon}
				title="No mock running"
				description="Start one from a collection's header to serve its saved example responses on a local URL."
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex flex-col gap-1 border-b border-border px-3 py-2">
				<div className="flex flex-wrap items-center gap-2">
					<MockIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
					<code className="font-mono text-xs">{mock.url}</code>
					<Button
						variant="ghost"
						size="sm"
						aria-label="Copy mock server URL"
						onClick={() => void copy(mock.url, "Mock server URL")}
					>
						<Copy className="h-3.5 w-3.5" aria-hidden="true" />
					</Button>
					<Badge variant="outline">{mock.collectionName}</Badge>

					{mocks.length > 1 && (
						<Select value={mock.mockId} onValueChange={show}>
							<SelectTrigger
								className="h-7 w-auto gap-1 text-xs"
								aria-label="Mock server"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ordered.map((option) => (
									<SelectItem key={option.mockId} value={option.mockId}>
										{`Port ${option.port}`}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}

					<div className="ml-auto">
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								stopMock.mutate(mock.mockId, {
									onError: (e) =>
										showToast(
											e instanceof Error
												? e.message
												: "Could not stop the mock server",
											"error"
										),
								})
							}
							disabled={stopMock.isPending}
						>
							<Square className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
							Stop
						</Button>
					</div>
				</div>
				<p className="pl-6 text-xs text-muted-foreground">
					{mock.latencyMs > 0 ? `${mock.latencyMs}ms latency` : "No added latency"}
					{mock.errorRatePct > 0 && `, ${mock.errorRatePct}% of answers fail`}
				</p>
			</header>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<section className="border-b border-border px-3 py-2">
					<h3 className="pb-2 text-xs font-medium text-muted-foreground">
						Routes ({routes.length})
					</h3>
					{routesQuery.isError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the routes"
							onRetry={() => void routesQuery.refetch()}
						/>
					) : (
						<ul>
							{routes.map((route) => (
								<li
									key={`${route.method} ${route.path} ${route.requestId}`}
									className="flex items-center gap-2 py-1 text-xs"
								>
									<span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
										{route.method}
									</span>
									<TruncatedText className="min-w-0 flex-1 font-mono">
										{route.path}
									</TruncatedText>
									<Badge variant="outline" className="shrink-0">
										{route.mode}
									</Badge>
									<span className="shrink-0 text-muted-foreground">
										{route.exampleName ??
											(route.hasExample ? "varies" : "no example")}
									</span>
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{route.hits}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="flex-1 px-3 py-2">
					<h3 className="pb-2 text-xs font-medium text-muted-foreground">Activity</h3>
					{activityQuery.isError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the activity log"
							onRetry={() => void activityQuery.refetch()}
						/>
					) : activity.length === 0 ? (
						<EmptyState
							variant="inline"
							title="Nothing served yet. Send a request to the URL above."
						/>
					) : (
						<ul>
							{activity.map((entry) => (
								<li
									key={`${entry.at}-${entry.path}`}
									className="flex items-center gap-2 py-1 text-xs"
								>
									<span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
										{entry.method}
									</span>
									<TruncatedText className="min-w-0 flex-1 font-mono">
										{entry.path}
									</TruncatedText>
									<span className="shrink-0 text-muted-foreground">
										{entry.injectedError
											? "injected failure"
											: (entry.exampleName ??
												(entry.requestId ? "no example" : "unmatched"))}
									</span>
									<Badge
										variant={entry.status >= 500 ? "destructive" : "outline"}
										className="shrink-0"
									>
										{entry.status}
									</Badge>
									<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
										{formatTime(entry.at)}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}

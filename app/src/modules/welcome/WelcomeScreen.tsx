
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * WelcomeScreen Component
 *
 * Location: Main content area only
 *
 * Modern welcome screen with quick actions, recent activity, and stats.
 */

import { useMemo } from "react";
import {
	Zap,
	Plus,
	Folder,
	History,
	Settings,
	Activity,
	Rocket,
	Gauge,
	Code,
	Database,
	ArrowRight,
	Clock,
	FileText,
} from "lucide-react";
import { useNavigationStore } from "@/stores";
import {
	useCollectionsQuery,
	useRunsQuery,
	useMultipleCollectionRequests,
	useCreateRequestMutation,
	useCreateCollectionMutation,
} from "@/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { formatDistanceToNow } from "date-fns";

export default function WelcomeScreen() {
	const { setActiveSidebarTab, navigateToRequest } = useNavigationStore();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: runs = [] } = useRunsQuery();
	const createRequestMutation = useCreateRequestMutation();
	const createCollectionMutation = useCreateCollectionMutation();

	// Get requests for all collections to calculate counts
	const allCollectionIds = collections.map((c) => c.id);
	const { requestsByCollection } = useMultipleCollectionRequests(allCollectionIds);

	// Get recent collections (last 3) with request counts
	const recentCollections = useMemo(() => {
		return collections
			.map((col) => ({
				...col,
				requestCount: requestsByCollection.get(col.id)?.length ?? 0,
			}))
			.sort((a, b) => {
				const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
				const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
				return bTime - aTime;
			})
			.slice(0, 3);
	}, [collections, requestsByCollection]);

	// Get recent runs (last 3)
	const recentRuns = useMemo(() => {
		return runs.sort((a, b) => (b.startTime || 0) - (a.startTime || 0)).slice(0, 3);
	}, [runs]);

	// Calculate stats
	const stats = useMemo(() => {
		const totalRequests = Array.from(requestsByCollection.values()).reduce(
			(sum, requests) => sum + requests.length,
			0
		);
		const totalRuns = runs.length;
		const completedRuns = runs.filter((r) => r.status === "completed").length;

		return {
			collections: collections.length,
			requests: totalRequests,
			totalRuns,
			completedRuns,
		};
	}, [collections, runs, requestsByCollection]);

	const hasData = collections.length > 0 || runs.length > 0;

	const handleNewRequest = async () => {
		try {
			// Get the first collection, or create one if none exists
			let targetCollectionId = collections[0]?.id;

			if (!targetCollectionId) {
				// Create a default collection
				const newCollection = await createCollectionMutation.mutateAsync({
					name: "New Collection",
				});
				targetCollectionId = newCollection.id;
			}

			// Create a new request
			const newRequest = await createRequestMutation.mutateAsync({
				collectionId: targetCollectionId,
				name: "New Request",
				method: "GET",
				url: "https://api.example.com",
			});

			// Navigate to the new request
			navigateToRequest(targetCollectionId, newRequest.id);
		} catch (error) {
			console.error("Failed to create new request:", error);
		}
	};

	return (
		<div className="flex-1 overflow-auto bg-gradient-to-br from-background via-background to-muted/20">
			<div className="container mx-auto px-8 py-12 max-w-6xl">
				{/* Hero Section */}
				<div className="text-center mb-12">
					<div className="flex items-center justify-center gap-4 mb-6">
						<div className="relative">
							<div className="absolute inset-0 bg-primary/20 blur-2xl" />
							<Zap className="w-16 h-16 text-primary relative z-10" />
						</div>
						<h1 className="text-5xl font-bold text-foreground">Vayu</h1>
					</div>
					<p className="text-xl text-muted-foreground mb-2">
						High-Performance API Testing Platform
					</p>
					<p className="text-sm text-muted-foreground/80">
						Load testing, scripting, and API development made simple
					</p>
				</div>

				{/* Quick Actions */}
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
					<Card
						className="hover:border-primary/50 transition-colors cursor-pointer group"
						onClick={handleNewRequest}
					>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-3">
								<div className="p-2  bg-primary/10 group-hover:bg-primary/20 transition-colors">
									<Plus className="w-5 h-5 text-primary" />
								</div>
								<CardTitle className="text-base">New Request</CardTitle>
							</div>
						</CardHeader>
						<CardContent>
							<CardDescription className="text-sm">
								Create your first API request
							</CardDescription>
						</CardContent>
					</Card>

					<Card
						className="hover:border-primary/50 transition-colors cursor-pointer group"
						onClick={() => setActiveSidebarTab("history")}
					>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-3">
								<div className="p-2  bg-primary/10 group-hover:bg-primary/20 transition-colors">
									<History className="w-5 h-5 text-primary" />
								</div>
								<CardTitle className="text-base">View History</CardTitle>
							</div>
						</CardHeader>
						<CardContent>
							<CardDescription className="text-sm">
								Browse test results and runs
							</CardDescription>
						</CardContent>
					</Card>

					<Card
						className="hover:border-primary/50 transition-colors cursor-pointer group"
						onClick={() => setActiveSidebarTab("variables")}
					>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-3">
								<div className="p-2  bg-primary/10 group-hover:bg-primary/20 transition-colors">
									<Database className="w-5 h-5 text-primary" />
								</div>
								<CardTitle className="text-base">Variables</CardTitle>
							</div>
						</CardHeader>
						<CardContent>
							<CardDescription className="text-sm">
								Manage environments and globals
							</CardDescription>
						</CardContent>
					</Card>

					<Card
						className="hover:border-primary/50 transition-colors cursor-pointer group"
						onClick={() => setActiveSidebarTab("settings")}
					>
						<CardHeader className="pb-3">
							<div className="flex items-center gap-3">
								<div className="p-2  bg-primary/10 group-hover:bg-primary/20 transition-colors">
									<Settings className="w-5 h-5 text-primary" />
								</div>
								<CardTitle className="text-base">Settings</CardTitle>
							</div>
						</CardHeader>
						<CardContent>
							<CardDescription className="text-sm">
								Configure engine and appearance
							</CardDescription>
						</CardContent>
					</Card>
				</div>

				{/* Stats & Recent Activity Grid */}
				<div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
					{/* Stats */}
					<div className="lg:col-span-2">
						<h2 className="text-lg font-semibold mb-4">Overview</h2>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
							<Card>
								<CardContent className="p-4">
									<div className="flex items-center gap-2 mb-2">
										<Folder className="w-4 h-4 text-muted-foreground" />
										<span className="text-xs text-muted-foreground">
											Collections
										</span>
									</div>
									<div className="text-2xl font-bold text-foreground">
										{stats.collections}
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardContent className="p-4">
									<div className="flex items-center gap-2 mb-2">
										<FileText className="w-4 h-4 text-muted-foreground" />
										<span className="text-xs text-muted-foreground">
											Requests
										</span>
									</div>
									<div className="text-2xl font-bold text-foreground">
										{stats.requests}
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardContent className="p-4">
									<div className="flex items-center gap-2 mb-2">
										<Activity className="w-4 h-4 text-muted-foreground" />
										<span className="text-xs text-muted-foreground">
											Total Runs
										</span>
									</div>
									<div className="text-2xl font-bold text-foreground">
										{stats.totalRuns}
									</div>
								</CardContent>
							</Card>

							<Card>
								<CardContent className="p-4">
									<div className="flex items-center gap-2 mb-2">
										<Rocket className="w-4 h-4 text-muted-foreground" />
										<span className="text-xs text-muted-foreground">
											Completed
										</span>
									</div>
									<div className="text-2xl font-bold text-foreground">
										{stats.completedRuns}
									</div>
								</CardContent>
							</Card>
						</div>
					</div>

					{/* Performance Highlights */}
					<div>
						<h2 className="text-lg font-semibold mb-4">Performance</h2>
						<div className="space-y-3">
							<Card>
								<CardContent className="p-4">
									<div className="flex items-center justify-between mb-1">
										<Gauge className="w-4 h-4 text-primary" />
										<span className="text-2xl font-bold text-primary">
											50k+
										</span>
									</div>
									<p className="text-xs text-muted-foreground">
										Requests per second
									</p>
								</CardContent>
							</Card>

							<Card>
								<CardContent className="p-4">
									<div className="flex items-center justify-between mb-1">
										<Zap className="w-4 h-4 text-primary" />
										<span className="text-2xl font-bold text-primary">
											&lt; 1ms
										</span>
									</div>
									<p className="text-xs text-muted-foreground">
										Overhead latency
									</p>
								</CardContent>
							</Card>
						</div>
					</div>
				</div>

				{/* Recent Activity */}
				{hasData && (
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
						{/* Recent Collections */}
						{recentCollections.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className="text-base flex items-center gap-2">
										<Folder className="w-4 h-4" />
										Recent Collections
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										{recentCollections.map((collection) => (
											<button
												key={collection.id}
												onClick={() => {
													setActiveSidebarTab("collections");
												}}
												className="w-full flex items-center justify-between p-3  hover:bg-accent transition-colors text-left group"
											>
												<div className="flex-1 min-w-0">
													<p className="text-sm font-medium truncate">
														{collection.name}
													</p>
													<p className="text-xs text-muted-foreground">
														{collection.requestCount}{" "}
														{collection.requestCount === 1
															? "request"
															: "requests"}
													</p>
												</div>
												<ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-2" />
											</button>
										))}
									</div>
								</CardContent>
							</Card>
						)}

						{/* Recent Runs */}
						{recentRuns.length > 0 && (
							<Card>
								<CardHeader>
									<CardTitle className="text-base flex items-center gap-2">
										<History className="w-4 h-4" />
										Recent Runs
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="space-y-2">
										{recentRuns.map((run) => (
											<button
												key={run.id}
												onClick={() => {
													setActiveSidebarTab("history");
												}}
												className="w-full flex items-center justify-between p-3  hover:bg-accent transition-colors text-left group"
											>
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2 mb-1">
														<span className="text-xs font-medium px-2 py-0.5 rounded bg-muted">
															{run.type === "load"
																? "Load Test"
																: "Design"}
														</span>
														{run.status === "completed" && (
															<span className="text-xs text-success">
																Completed
															</span>
														)}
														{run.status === "stopped" && (
															<span className="text-xs text-warning">
																Stopped
															</span>
														)}
													</div>
													{run.startTime && (
														<p className="text-xs text-muted-foreground flex items-center gap-1">
															<Clock className="w-3 h-3" />
															{formatDistanceToNow(run.startTime, {
																addSuffix: true,
															})}
														</p>
													)}
												</div>
												<ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-2" />
											</button>
										))}
									</div>
								</CardContent>
							</Card>
						)}
					</div>
				)}

				{/* Features */}
				<div className="mb-12">
					<h2 className="text-lg font-semibold mb-4">Key Features</h2>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
						<Card>
							<CardContent className="p-4">
								<div className="flex items-center gap-3 mb-2">
									<Code className="w-5 h-5 text-primary" />
									<CardTitle className="text-sm">QuickJS Scripting</CardTitle>
								</div>
								<CardDescription className="text-xs">
									Powerful JavaScript engine for pre/post-request scripts
								</CardDescription>
							</CardContent>
						</Card>

						<Card>
							<CardContent className="p-4">
								<div className="flex items-center gap-3 mb-2">
									<Activity className="w-5 h-5 text-primary" />
									<CardTitle className="text-sm">Real-Time Metrics</CardTitle>
								</div>
								<CardDescription className="text-xs">
									Live streaming of load test performance data
								</CardDescription>
							</CardContent>
						</Card>

						<Card>
							<CardContent className="p-4">
								<div className="flex items-center gap-3 mb-2">
									<Database className="w-5 h-5 text-primary" />
									<CardTitle className="text-sm">Environment Variables</CardTitle>
								</div>
								<CardDescription className="text-xs">
									Manage globals, collections, and environment-specific vars
								</CardDescription>
							</CardContent>
						</Card>

						<Card>
							<CardContent className="p-4">
								<div className="flex items-center gap-3 mb-2">
									<History className="w-5 h-5 text-primary" />
									<CardTitle className="text-sm">Complete History</CardTitle>
								</div>
								<CardDescription className="text-xs">
									Full request/response history with detailed analysis
								</CardDescription>
							</CardContent>
						</Card>
					</div>
				</div>

				
			</div>
		</div>
	);
}

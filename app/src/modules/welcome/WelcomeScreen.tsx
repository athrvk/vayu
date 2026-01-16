/**
 * WelcomeScreen Component
 *
 * Location: Main content area only
 *
 * Displays the welcome screen when no request is selected.
 */

import { Zap, BookOpen } from "lucide-react";
import { useNavigationStore } from "@/stores";
import { Button, Card, CardContent } from "@/components/ui";

export default function WelcomeScreen() {
	const { setActiveSidebarTab } = useNavigationStore();

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="text-center max-w-2xl">
				<div className="flex items-center justify-center gap-3 mb-6">
					<Zap className="w-12 h-12 text-primary" />
					<h1 className="text-4xl font-bold text-foreground">Vayu</h1>
				</div>

				<p className="text-xl text-muted-foreground mb-8">
					High-Performance API Testing Platform
				</p>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
					<Card>
						<CardContent className="p-6">
							<div className="text-4xl font-bold text-primary mb-2">50k+</div>
							<div className="text-sm text-muted-foreground">Requests per second</div>
						</CardContent>
					</Card>

					<Card>
						<CardContent className="p-6">
							<div className="text-4xl font-bold text-primary mb-2">&lt; 1ms</div>
							<div className="text-sm text-muted-foreground">Overhead latency</div>
						</CardContent>
					</Card>
				</div>

				<div className="space-y-4">
					<Button
						onClick={() => setActiveSidebarTab("collections")}
						className="w-full"
						size="lg"
					>
						Get Started - Create Your First Request
					</Button>

					<Button variant="outline" className="w-full gap-2" size="lg">
						<BookOpen className="w-5 h-5" />
						View Documentation
					</Button>
				</div>

				<div className="mt-12 text-sm text-muted-foreground space-y-1">
					<p>✓ QuickJS scripting engine for tests</p>
					<p>✓ Real-time load test metrics streaming</p>
					<p>✓ Environment variable management</p>
					<p>✓ Complete request history</p>
				</div>
			</div>
		</div>
	);
}

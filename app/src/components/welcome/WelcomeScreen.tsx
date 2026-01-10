import { Zap, BookOpen } from "lucide-react";
import { useAppStore } from "@/stores";

export default function WelcomeScreen() {
	const { setActiveSidebarTab } = useAppStore();

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="text-center max-w-2xl">
				<div className="flex items-center justify-center gap-3 mb-6">
					<Zap className="w-12 h-12 text-primary-600" />
					<h1 className="text-4xl font-bold text-gray-900">Vayu Desktop</h1>
				</div>

				<p className="text-xl text-gray-600 mb-8">
					High-Performance API Testing Platform
				</p>

				<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
					<div className="p-6 bg-white rounded-lg border border-gray-200 shadow-sm">
						<div className="text-4xl font-bold text-primary-600 mb-2">50k+</div>
						<div className="text-sm text-gray-600">Requests per second</div>
					</div>

					<div className="p-6 bg-white rounded-lg border border-gray-200 shadow-sm">
						<div className="text-4xl font-bold text-primary-600 mb-2">
							&lt; 1ms
						</div>
						<div className="text-sm text-gray-600">Overhead latency</div>
					</div>
				</div>

				<div className="space-y-4">
					<button
						onClick={() => setActiveSidebarTab("collections")}
						className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors font-medium"
					>
						Get Started - Create Your First Request
					</button>

					<button className="w-full px-6 py-3 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium flex items-center justify-center gap-2">
						<BookOpen className="w-5 h-5" />
						View Documentation
					</button>
				</div>

				<div className="mt-12 text-sm text-gray-500">
					<p>✓ QuickJS scripting engine for tests</p>
					<p>✓ Real-time load test metrics streaming</p>
					<p>✓ Environment variable management</p>
					<p>✓ Complete request history</p>
				</div>
			</div>
		</div>
	);
}

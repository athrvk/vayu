import Shell from "./components/layout/Shell";
import { useAppStore } from "./stores";
import {
	useHealthQuery,
	usePrefetchCollectionsAndRequests,
	useRunsQuery,
	useScriptCompletionsQuery,
} from "./queries";

function App() {
	const { isEngineConnected } = useAppStore();

	// Initialize health check with automatic polling
	useHealthQuery();

	// Prefetch collections and all their requests (TanStack handles caching automatically)
	usePrefetchCollectionsAndRequests();
	useRunsQuery();
	useScriptCompletionsQuery();

	// Log connection status for debugging
	if (isEngineConnected) {
		console.log("App: Engine connected, data queries active");
	}

	return <Shell />;
}

export default App;

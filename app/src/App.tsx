import { useEffect } from "react";
import Shell from "./components/layout/Shell";
import { useHealthCheck, useCollections, useRuns } from "./hooks";
import { useAppStore } from "./stores";
import { useScriptCompletionsStore } from "./stores/script-completions-store";

function App() {
	// Initialize health check
	useHealthCheck();

	const { loadCollections } = useCollections();
	const { loadRuns } = useRuns();
	const { isEngineConnected } = useAppStore();
	const { fetchCompletions } = useScriptCompletionsStore();

	// Load initial data when engine connects
	useEffect(() => {
		console.log("App: Engine connected status:", isEngineConnected);
		if (isEngineConnected) {
			console.log("App: Loading collections and runs...");
			loadCollections();
			loadRuns();
			// Fetch script completions for Monaco editor
			fetchCompletions();
		}
	}, [isEngineConnected, loadCollections, loadRuns, fetchCompletions]);

	return <Shell />;
}

export default App;

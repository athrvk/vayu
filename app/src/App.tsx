import { useEffect } from "react";
import Shell from "./components/layout/Shell";
import { useHealthCheck, useCollections, useRuns } from "./hooks";
import { useAppStore } from "./stores";

function App() {
	// Initialize health check
	useHealthCheck();

	const { loadCollections } = useCollections();
	const { loadRuns } = useRuns();
	const { isEngineConnected } = useAppStore();

	// Load initial data when engine connects
	useEffect(() => {
		console.log("App: Engine connected status:", isEngineConnected);
		if (isEngineConnected) {
			console.log("App: Loading collections and runs...");
			loadCollections();
			loadRuns();
		}
	}, [isEngineConnected, loadCollections, loadRuns]);

	return <Shell />;
}

export default App;

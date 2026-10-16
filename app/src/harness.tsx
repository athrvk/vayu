import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client";
import { TooltipProvider } from "./components/ui";
import { RequestBuilderContext } from "./modules/request-builder/context";
import ResponseViewer from "./modules/request-builder/components/ResponseViewer";
import "./index.css";
const q = new URLSearchParams(location.search);
const mode = q.get("mode"); document.documentElement.style.setProperty("--w", (q.get("w") || "440") + "px");
if (q.get("theme") === "dark") document.documentElement.classList.add("dark");
const response: any = {
	status: 200, statusText: "OK", headers: { "content-type": "application/json", a: "1" },
	body: '{"ok":true}', bodyType: "json", size: 11, time: 12,
	...(mode === "script" ? { postScriptError: "ReferenceError: foo is not defined" } : {}),
	...(mode === "tests" ? { testResults: [{ name: "status is 200", passed: true }, { name: "has id", passed: false, error: "expected id" }] } : {}),
};
const value: any = { response, isExecuting: false, request: { id: null } };
ReactDOM.createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}><TooltipProvider>
		<RequestBuilderContext.Provider value={value}><ResponseViewer /></RequestBuilderContext.Provider>
	</TooltipProvider></QueryClientProvider>);

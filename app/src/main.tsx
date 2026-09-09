/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { queryClient } from "./lib/query-client";
import { TooltipProvider } from "./components/ui";
import { TIMING } from "./config/timing";
import { ErrorBoundary, logError } from "./errors";
import App from "./App";
import "./index.css";

/**
 * Whatever `ErrorBoundary` cannot reach: an error thrown outside a component's
 * render (an event handler, a timer, a raw DOM listener) and a rejected
 * promise nobody awaited (#1558). Registered once, for the process's whole
 * life - React's own render errors still go through `ErrorBoundary`, which is
 * a narrower, more specific report (a component stack) than either listener
 * below can build.
 */
window.addEventListener("error", (event) => {
	logError(event.error instanceof Error ? event.error : new Error(event.message), "high", {
		component: "window",
		action: "error",
	});
});

window.addEventListener("unhandledrejection", (event) => {
	const reason: unknown = event.reason;
	logError(reason instanceof Error ? reason : new Error(String(reason)), "high", {
		component: "window",
		action: "unhandledrejection",
	});
});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<ErrorBoundary>
			<QueryClientProvider client={queryClient}>
				{/*
				 * One tooltip delay for the whole app.
				 *
				 * This was a bare provider, so Radix's 700ms default governed almost
				 * everything while two components set 150ms locally - and two more
				 * mounted bare nested providers, which *re-establish* 700ms for their
				 * subtree rather than inheriting. `TIMING.TOOLTIP_DELAY_MS` described
				 * itself as "used across the app" and reached none of it.
				 *
				 * A nested provider is now the exception that has to justify itself.
				 */}
				<TooltipProvider delayDuration={TIMING.TOOLTIP_DELAY_MS}>
					<App />
				</TooltipProvider>
				<ReactQueryDevtools initialIsOpen={false} />
			</QueryClientProvider>
		</ErrorBoundary>
	</React.StrictMode>
);

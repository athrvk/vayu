/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import "@/lib/monaco-setup";

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { queryClient } from "./lib/query-client";
import { TooltipProvider } from "./components/ui";
import { TIMING } from "./config/timing";
import { ErrorBoundary } from "./errors";
import App from "./App";
import "./index.css";

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

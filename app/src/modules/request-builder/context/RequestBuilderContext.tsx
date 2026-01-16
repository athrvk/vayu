/**
 * RequestBuilder Context
 *
 * Provides shared state and variable resolution for all request builder components
 */

import { createContext, useContext } from "react";
import type { RequestBuilderContextValue } from "../types";

export const RequestBuilderContext = createContext<RequestBuilderContextValue | null>(null);

export function useRequestBuilderContext(): RequestBuilderContextValue {
	const context = useContext(RequestBuilderContext);
	if (!context) {
		throw new Error("useRequestBuilderContext must be used within RequestBuilderProvider");
	}
	return context;
}

/**
 * Variable Resolver Utility
 * 
 * Handles {{variable}} substitution in URLs, headers, and body content.
 * Resolution priority (higher overrides lower):
 * 1. Environment variables (highest priority)
 * 2. Collection variables
 * 3. Global variables (lowest priority)
 */

import type { VariableInfo, VariableScope } from "@/types";

// Regex to match {{variableName}} patterns
const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

export interface VariableSources {
	globals: Record<string, string>;
	collection: Record<string, string>;
	environment: Record<string, string>;
}

export interface ResolvedVariable {
	original: string;      // e.g., "{{baseUrl}}"
	name: string;          // e.g., "baseUrl"
	value: string | null;  // Resolved value or null if not found
	scope: VariableScope | null;  // Which scope it was resolved from
}

/**
 * Resolve all variables in a string using the provided sources.
 * Priority: environment > collection > global
 */
export function resolveVariables(
	template: string,
	sources: VariableSources
): string {
	if (!template) return template;
	
	return template.replace(VARIABLE_PATTERN, (match, varName) => {
		const name = varName.trim();
		
		// Check environment first (highest priority)
		if (sources.environment && name in sources.environment) {
			return sources.environment[name];
		}
		
		// Check collection variables
		if (sources.collection && name in sources.collection) {
			return sources.collection[name];
		}
		
		// Check globals (lowest priority)
		if (sources.globals && name in sources.globals) {
			return sources.globals[name];
		}
		
		// Variable not found - return original placeholder
		return match;
	});
}

/**
 * Find all variables in a template string and their resolved values.
 * Useful for preview/debugging.
 */
export function findVariables(
	template: string,
	sources: VariableSources
): ResolvedVariable[] {
	if (!template) return [];
	
	const results: ResolvedVariable[] = [];
	const seen = new Set<string>();
	
	let match;
	while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
		const [original, varName] = match;
		const name = varName.trim();
		
		// Skip duplicates
		if (seen.has(name)) continue;
		seen.add(name);
		
		let value: string | null = null;
		let scope: VariableScope | null = null;
		
		// Check environment first
		if (sources.environment && name in sources.environment) {
			value = sources.environment[name];
			scope = 'environment';
		}
		// Check collection
		else if (sources.collection && name in sources.collection) {
			value = sources.collection[name];
			scope = 'collection';
		}
		// Check globals
		else if (sources.globals && name in sources.globals) {
			value = sources.globals[name];
			scope = 'global';
		}
		
		results.push({ original, name, value, scope });
	}
	
	// Reset regex lastIndex
	VARIABLE_PATTERN.lastIndex = 0;
	
	return results;
}

/**
 * Get all available variables from all sources as a flat list.
 * Useful for autocomplete suggestions.
 */
export function getAllVariables(
	sources: VariableSources,
	collectionName?: string,
	environmentName?: string
): VariableInfo[] {
	const variables: VariableInfo[] = [];
	
	// Add globals
	if (sources.globals) {
		for (const [name, value] of Object.entries(sources.globals)) {
			variables.push({
				name,
				value,
				scope: 'global',
				sourceName: 'Globals',
			});
		}
	}
	
	// Add collection variables
	if (sources.collection) {
		for (const [name, value] of Object.entries(sources.collection)) {
			variables.push({
				name,
				value,
				scope: 'collection',
				sourceName: collectionName || 'Collection',
			});
		}
	}
	
	// Add environment variables
	if (sources.environment) {
		for (const [name, value] of Object.entries(sources.environment)) {
			variables.push({
				name,
				value,
				scope: 'environment',
				sourceName: environmentName || 'Environment',
			});
		}
	}
	
	return variables;
}

/**
 * Check if a string contains any variable placeholders
 */
export function hasVariables(text: string): boolean {
	if (!text) return false;
	VARIABLE_PATTERN.lastIndex = 0;
	return VARIABLE_PATTERN.test(text);
}

/**
 * Extract just the variable names from a template
 */
export function extractVariableNames(template: string): string[] {
	if (!template) return [];
	
	const names: string[] = [];
	let match;
	
	while ((match = VARIABLE_PATTERN.exec(template)) !== null) {
		const name = match[1].trim();
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	
	VARIABLE_PATTERN.lastIndex = 0;
	return names;
}

/**
 * Get scope display label
 */
export function getScopeLabel(scope: VariableScope): string {
	switch (scope) {
		case 'global':
			return 'Global';
		case 'collection':
			return 'Collection';
		case 'environment':
			return 'Environment';
		default:
			return 'Unknown';
	}
}

/**
 * Get scope color for UI
 */
export function getScopeColor(scope: VariableScope): string {
	switch (scope) {
		case 'global':
			return 'text-purple-600 bg-purple-50';
		case 'collection':
			return 'text-blue-600 bg-blue-50';
		case 'environment':
			return 'text-green-600 bg-green-50';
		default:
			return 'text-gray-600 bg-gray-50';
	}
}

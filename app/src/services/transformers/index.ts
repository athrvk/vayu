/**
 * Transformers Index
 *
 * Central export for all data transformers.
 * These transformers handle conversion between frontend (snake_case) and backend (camelCase) formats.
 */

export { RequestTransformer, type BackendRequest } from "./requestTransformer";
export { CollectionTransformer, type BackendCollection } from "./collectionTransformer";
export { RunReportTransformer } from "./runReportTransformer";
export { GlobalsTransformer, type BackendGlobalsResponse } from "./globalsTransformer";

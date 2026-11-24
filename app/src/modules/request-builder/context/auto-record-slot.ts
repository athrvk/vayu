/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The fallback memory key. The settings that write a reversible side effect (the body mode's
 * `Content-Type`, the Event stream toggle's `Accept`, the GraphQL mode's `POST`) mark ownership on
 * the request itself: header rows on `KeyValueEntry.source` (`utils/auto-header.ts`, #1481), the
 * method on `RequestState.methodSource` (`panels/body/graphql-method.ts`, #1505), as durable as the
 * request, where a ref-held record lost ownership on reload. {@link UNSAVED_AUTO_KEY} remains for
 * the Send-with-row picker's provider-held per-request row memory (#1271).
 */

/**
 * The key a record is filed under while the builder names no identity, the provider's one fallback
 * (#1271), read by the Send-with-row memory, the editor models and the model lifecycle; one
 * convention spelled twice drifts. A builder names its identity with the provider's `memoryKey`,
 * default `request.id`. A request tab always opens on a request the backend created
 * (`useNewRequest`), and History's editable copy of a stored run passes its run id (#1272), so no
 * app builder reaches this key; it stays because otherwise such builders would share the
 * last-written key, and the rules read `null` against `null` as a match, handing a shared bucket
 * out as owned. The open-tab sweep never drops it, since a key naming no tab is unbounded by tabs:
 * a second reason to declare an identity.
 */
export const UNSAVED_AUTO_KEY = "__unsaved__";

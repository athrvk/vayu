/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The three reversible-side-effect settings this module used to hold a
 * provider-keyed record for - the body mode's `Content-Type`, the Event
 * stream toggle's `Accept`, the GraphQL mode's `POST` - all now mark
 * ownership on the request's own state instead: the two header rows carry it
 * on the row itself (`KeyValueEntry.source`, `utils/auto-header.ts`, issue
 * #1481), and the method carries it on `RequestState.methodSource`
 * (`panels/body/graphql-method.ts`, issue #1505). A ref-based record could not
 * survive a reload, so a stale auto-written value was then indistinguishable
 * from one the user chose; a value on the request itself is exactly as
 * durable as the rest of the request. The generic per-request slot that held
 * these records (`useAutoRecordSlot`) went with the last of them - see the
 * VCS history for its shape if a future setting needs the pattern again.
 *
 * {@link UNSAVED_AUTO_KEY} outlives that slot: the Send-with-row picker's row
 * memory (issue #1271) still is a provider-held per-request map, and needs
 * the same fallback key for a builder that declares no identity of its own.
 */

/**
 * The key a record is filed under while the builder names no identity at all -
 * the provider's one fallback, read by the Send-with-row picker's memory as
 * well as by the slots here (issue #1271). One convention spelled twice is how
 * two spellings of it drift apart.
 *
 * A builder says which identity it files under with the provider's `memoryKey`
 * prop, defaulting to `request.id`. A request tab is always opened against a
 * request the backend has already created (`useNewRequest`), and the editable
 * copy History renders for a stored run - the one builder with no request id -
 * passes its run id (issue #1272), so nothing reaches this key in the app
 * today. It stays as the answer for a builder that has neither, because the
 * alternative is every such builder sharing whichever key was written last:
 * the rules read a `requestId` of `null` against another `null` as a match, so
 * a shared bucket is handed out as owned rather than refused.
 *
 * It is the one key the open-tab sweep never drops. That is what it costs: a
 * key naming no tab cannot be bounded by the tabs, which is the second reason
 * to declare an identity that does.
 */
export const UNSAVED_AUTO_KEY = "__unsaved__";

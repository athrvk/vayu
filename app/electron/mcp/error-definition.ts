/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an "error" is in a load-test run's numbers (issue #2124), for the
 * descriptions of every tool, resource and prompt that hands back an error
 * count or rate. One sentence in one place, because the engine has one
 * definition and an agent reading a rate with a different one in mind draws
 * the wrong conclusion (a run answering 15% 500s is not "0% errors").
 * `docs/engine/api-reference.md` ("What counts as an error") is the engine side.
 */
export const RUN_ERROR_DEFINITION_SENTENCE =
	"An error is a response with a status outside 2xx and 3xx (an HTTP error) or no response at all " +
	"(a timeout, a refused connection, a DNS or TLS failure); a 3xx redirect is a success. Every error " +
	"count and error rate in a run's numbers uses that one definition, and each count splits into " +
	"HTTP errors and No response: `httpErrors` / `noResponse` on a live tick, `http_errors` / " +
	"`no_response` on a stored tick, `httpErrorRequests` / `noResponseRequests` in a report's `summary`. " +
	"A request cancelled by a user Stop is not an error: it is in no error count or rate, nor in the " +
	"totals, and is reported apart as `cancelledRequests` in the report's `summary`.";

/**
 * What a tool that hands back an error count says in place of the sentence
 * above (#2441): the definition's two halves and where the whole of it is.
 * `get_run_report` and the run report resource carry the sentence itself.
 */
export const RUN_ERROR_DEFINITION_POINTER =
	"An error is a status outside 2xx/3xx or no response, never a Stop-cancelled request; get_run_report states the full definition.";

#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/operation_match.hpp
 * @brief Matching a collection's existing requests to a document's operations,
 *        by method and path template (issue #638, moved engine-side by #761).
 *
 * This is what "bind an existing collection to a spec" needs and an import does
 * not: an import *creates* the requests, so it stamps each one's identity as it
 * builds it. Binding after the fact has two independent lists and has to work
 * out which request is which operation - by structure, because that is the only
 * thing the two sides share. A request's URL carries `{{baseUrl}}` and Vayu's
 * `{{petId}}` variables; the document writes `/pets/{petId}` and folds the
 * server into `servers[]`.
 *
 * So both sides are reduced to a **path shape**: the origin dropped, the query
 * and fragment dropped, and every template placeholder - `{{petId}}`, `{petId}`
 * - flattened to a single `{}`. Flattening the name too is deliberate: a spec
 * that renames its path parameter describes the same endpoint, and a match that
 * turned on the parameter's spelling would report a rename as "removed and
 * added". Two operations that differ only in a parameter name are the same
 * position on the server and cannot both exist.
 *
 * A second pass then offers each remaining request to the templates it could be
 * an instance of, because a hand-built collection writes the id in
 * (`/pets/42`), and a matcher that only compared shapes would find nothing
 * outside collections that were already imported from a spec.
 *
 * Ambiguity is refused rather than guessed at, in both passes: when two requests
 * reduce to the same shape, or one request could be two operations, neither is
 * matched and the count says so. A wrong identity is worse than none - the sync
 * (#627) applies changes *by* it.
 *
 * **Why the engine owns this** (#761's phase B decision): the same matching had
 * to be reachable from the main process for an agent to bind a collection over
 * MCP, and the repo's recorded answer to "MCP needs renderer logic" is engine
 * ownership rather than a second TypeScript copy - #226 deleted MCP's ported
 * composition pipeline in favour of `POST /compose`. So the rule lives here and
 * `POST /specs/match` is the one way to ask it, exactly as the renderer's Spec
 * tab now does.
 *
 * It parses no OpenAPI, which is the division `core/spec_coverage.hpp` states:
 * the caller supplies the operation identities a document declares, the same
 * ones it stores as the `operations` index, and nothing here reads a document.
 */

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace vayu::core {

/** One request the matcher is offered - its stored id, method and URL. */
struct MatchableRequest {
    std::string id;
    std::string method;
    /// The URL as written, `{{baseUrl}}` and all - never a resolved one.
    std::string url;
};

/**
 * One operation the document declares, as the identity a match stamps onto a
 * request (`requests.spec_operation`).
 *
 * `operation_id` is "" for an operation that declares none, the same spelling
 * `DeclaredOperation` uses, because an OpenAPI operation may legally have none.
 */
struct MatchableOperation {
    std::string operation_id;
    std::string method;
    /// The path *template* (`/pets/{petId}`), never a concrete URL.
    std::string path;
};

/** One request paired with the operation it turned out to be, by index. */
struct OperationPairing {
    size_t request;
    size_t operation;
};

/**
 * Indices into the two lists that were offered, never copies: the caller holds
 * both and knows how it wants to name them, and an index cannot drift from the
 * row it came from.
 */
struct MatchResult {
    /// Requests that resolved to exactly one operation, and it to exactly one
    /// of them, in the order the first pass then the second pass found them.
    std::vector<OperationPairing> matched;
    /// Requests left over - no operation, or an ambiguous shape. Input order.
    std::vector<size_t> unmatched_requests;
    /// Operations no request claimed. These become new requests in a sync
    /// (#627), never here. Input order.
    std::vector<size_t> unmatched_operations;
};

/**
 * A request URL split into the part that says *where* it goes and the part that
 * says *what* it addresses.
 *
 * One decomposition, two readers: matching flattens the path to compare it to a
 * spec path, and export keeps both halves - the origin becomes a `servers[]`
 * entry and the path becomes a `paths` key. A second copy of this would be the
 * hand-rolled-copy defect in the one function that decides what counts as an
 * origin.
 */
struct RequestUrlParts {
    /**
     * The `{{baseUrl}}` token, or the `scheme://host[:port]`, the URL starts
     * with - absent when it states neither.
     */
    std::optional<std::string> origin;
    /**
     * The path, with its template placeholders exactly as the URL wrote them
     * (`/pets/{{petId}}`), or absent when the URL states no path at all.
     */
    std::optional<std::string> path;
};

[[nodiscard]] RequestUrlParts split_request_url (std::string_view url);

/**
 * The path portion of a request URL, reduced to a shape, or `std::nullopt` when
 * there is nothing that can be compared to a spec path.
 *
 * Absent and not `"/"`: a request whose URL is only a variable (`{{baseUrl}}`)
 * states no path, and defaulting it to the root would match it against the
 * document's root operation - a match nobody asked for.
 */
[[nodiscard]] std::optional<std::string> request_path_shape (std::string_view url);

/**
 * A spec path (`/pets/{petId}`) reduced to the same shape a request URL reduces
 * to, so the two are comparable.
 */
[[nodiscard]] std::string spec_path_shape (std::string_view path);

/** `GET /pets/{}` - the key both sides are bucketed by. */
[[nodiscard]] std::string
operation_shape_key (std::string_view method, std::string_view path_shape);

/**
 * Pair a collection's requests with a document's operations, one to one.
 *
 * Neither side is mutated and nothing is written: the caller decides what to do
 * with the result, and shows the counts before it does.
 */
[[nodiscard]] MatchResult match_operations (const std::vector<MatchableRequest>& requests,
const std::vector<MatchableOperation>& operations);

} // namespace vayu::core

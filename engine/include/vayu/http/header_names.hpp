#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <string>

/**
 * @file header_names.hpp
 * @brief When two header names become one - one rule, one place.
 *
 * A header name is substituted like any other field, and the map it lands in
 * holds one value per name. So two names that resolve alike do not both go out:
 * the second lands on the first's key and one of the two headers is gone, with
 * nothing said. `{{tenant_header}}: acme` beside a literal `X-Tenant: legacy`
 * sends one header, and `Headers` compares case-insensitively, so a `{{h}}`
 * resolving to `authorization` erases an `Authorization` the user typed too.
 *
 * That is the same quiet wrong request the header-text rule refuses in
 * `header_text.hpp`: there a value *forges* a header, here a value *erases*
 * one. Both are a request the author did not write, and neither is visible from
 * the response.
 *
 * ## Refusal, never repair
 *
 * The alternative is to define which of the two survives, and there is no
 * honest answer: the names are equally the author's, one is not more meant than
 * the other, and "the one the map iterated last" is an implementation detail
 * rather than a rule. Sending both is not on the table either - a single-valued
 * map is what the engine and libcurl both hold. So the request is refused, and
 * the message names the header as written beside the name it produced, which is
 * the pair the author has to go and look at.
 *
 * ## Which collisions this is about
 *
 * Only the ones **resolution produced**. Two names the author typed into one
 * request are two lines they can see side by side, and composition's stored
 * flattening has always let the later one win - a rule that is visible in the
 * editor and stays as it was. A name that only collides *after* a variable is
 * substituted is invisible until the request comes back wrong, which is the
 * whole difference.
 *
 * ## Where the rule is enforced
 *
 * Three layers, one rule, each naming what it alone knows - the shape
 * `header_text.hpp` describes for its own:
 *
 * - **A bound data cell** (`core/scenario_data.cpp`, issue #732) refuses at
 *   bind time, naming the column and the row. It words its own message because
 *   only it knows the row.
 * - **A composed `{{variable}}`** (`http/request_composer.cpp`, issue #1051)
 *   refuses at composition with a `400`, naming both spellings.
 * - **The residual pass** (`http/request_exchange.cpp`, issue #1008) refuses
 *   with the same words at execute time, where a name a pre-request script has
 *   just defined can collide with one composition already resolved. It has no
 *   `400` to return, so it refuses the send the way the pre-send gate does -
 *   see `resolve_residual_tokens`.
 *
 * The pre-send gate cannot be that backstop here, and this is the reason the
 * rule is enforced where the map is rebuilt rather than checked once before the
 * transfer: by the time the gate sees a request, the collision has already
 * happened and the erased header is simply not there to notice.
 */

namespace vayu::http {

/// Two header names that became one when `{{variables}}` were resolved into
/// them.
struct HeaderNameCollision {
    /// One of the two names as the request carries it, before resolution - the
    /// text the author has to go and fix, so the message names what was
    /// written rather than only what it produced.
    std::string written;
    /// The other one, also as written. Which of the two is which follows the
    /// order the names were walked in and carries no meaning: neither is more
    /// at fault than the other, which is why neither is repaired.
    std::string other;
    /// The one name they both landed on.
    std::string produced;
};

/**
 * @brief The refusal a header-name collision reads as.
 *
 * One wording for both layers that resolve a name - composition and the
 * residual pass - because they are one rule and a caller reading two
 * differently-worded refusals would reasonably think they were two.
 */
[[nodiscard]] std::string describe_header_name_collision (const HeaderNameCollision& collision);

} // namespace vayu::http

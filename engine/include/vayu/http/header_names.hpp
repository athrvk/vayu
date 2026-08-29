#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <map>
#include <string>
#include <string_view>

// For `Headers`, whose comparison `HeaderNameOrigins` is keyed by rather than
// naming a second one of its own.
#include "vayu/types.hpp"

/**
 * @file header_names.hpp
 * @brief What resolution can do to a header *name* - the rules, one place.
 *
 * Two of them, both about a name a variable produced rather than a name the
 * author typed: two names that become one (below), and a name that becomes
 * nothing at all (`describe_empty_header_name`). Neither is visible from the
 * response, and neither is caught anywhere further down the send.
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
 * - **A script's own `pm.sendRequest`** (`runtime/script_engine.cpp`, issue
 *   #1067) refuses in the same words with the call named in front of them,
 *   because that send is the script's rather than the request's - see
 *   `resolve_send_request_headers`. It throws where the others refuse, since a
 *   script asked for the send and a throw is what it can catch.
 *
 * The pre-send gate cannot be that backstop here, and this is the reason the
 * rule is enforced where the map is rebuilt rather than checked once before the
 * transfer: by the time the gate sees a request, the collision has already
 * happened and the erased header is simply not there to notice.
 *
 * ## The name that resolves to nothing
 *
 * `describe_empty_header_name` is the second rule, and it is the same argument
 * one step further: `{{blank}}: acme` with `blank` empty is not a header the
 * author can see either, and the gate is no backstop for it for the same reason
 * - it reads header text for the bytes that break a line, and an empty name
 * breaks nothing. What is left goes out as the line `": acme"`, under no name
 * at all. The three layers that resolve a name refuse it - composition and the
 * residual pass (issue #1084) and `pm.sendRequest` (issue #1067), which met it
 * first because a script writes header names of its own - and so does the one
 * that *binds* a name from a data row (issue #1095, below).
 *
 * Unlike a collision, composition refuses this one however the name got there.
 * A collision has to be one resolution produced, because two names the author
 * typed are two lines they can see; a name that is not there is nothing to see
 * whoever wrote it. In practice both flattenings that feed composition - the
 * stored one and the renderer's - drop such a row before it arrives, so what
 * that catches beyond a produced name is a caller that built the payload
 * itself.
 *
 * **Every layer that can leave a header nameless refuses it** (issue #1095),
 * which is one layer more than the collision rule has and one reach wider at
 * the residual pass:
 *
 * - **A bound data cell** refuses it at bind time, in these words with the row
 *   in front of them - a blank cell is an ordinary thing for a data file to
 *   hold, and the load path runs no residual pass, so this is the layer or
 *   nothing. It words the *collision* itself, because that message has to name
 *   what the bound name collided with; this one has only the row to add.
 * - **The residual pass** reads every name for this rule rather than only the
 *   templated ones, so a name a script has just emptied and a payload posted
 *   straight to `POST /execute` carrying an empty key are both refused. The
 *   collision rule keeps the narrower reach and loses nothing by it: a request
 *   that arrives already resolved cannot carry a collision to find, since
 *   `Headers` holds one value per name and compares without case, so two names
 *   that are already equal are already one.
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
 * @brief Each name resolution produced, against the name as written that
 * produced it.
 *
 * What a layer rebuilding a header map keeps beside the map, because the
 * rebuilt `Headers` remembers only the spelling that got there first and a
 * collision has to be named with both. It is what makes `emplace` the whole of
 * the detection: the name that fails to go in has already found the one it
 * would have erased, and the value that was there says how that one was
 * written.
 *
 * Keyed by `Headers`' own comparison rather than by a comparator named again
 * here, because the collision this finds is the one *that* map will make - the
 * two cannot come to disagree about which two names are one. It is deliberately
 * not a `Headers` itself: its value is a header name, never a header value.
 *
 * The bind-time layer keeps none, and that is the distinction rather than an
 * omission - its message names only the surviving key, which the rebuilt
 * `Headers` already holds (`core/scenario_data.cpp`).
 */
using HeaderNameOrigins = std::map<std::string, std::string, Headers::key_compare>;

/**
 * @brief The refusal a header-name collision reads as.
 *
 * One wording for every layer that resolves a name - composition, the residual
 * pass and a script's own `pm.sendRequest` - because they are one rule and a
 * caller reading three differently-worded refusals would reasonably think they
 * were three. A layer may name itself in front of the wording, never inside it.
 */
[[nodiscard]] std::string describe_header_name_collision (const HeaderNameCollision& collision);

/**
 * @brief The refusal a header name that resolved to nothing reads as.
 *
 * One wording for four layers - the three above and the bind, which is one more
 * than the collision rule reaches - on the same reasoning: a caller meeting this
 * at composition, again at execute time and again from a data row is meeting one
 * rule, and four spellings of it would read as four. A layer may name itself in
 * front of the wording, never inside it.
 *
 * @param written the name as the request carries it, before resolution. It is
 *        the whole of what the message can name - what the name produced is
 *        nothing, and `{{blank}}` is what the author has to go and look at.
 *        Empty for a name that arrived with nothing in it rather than resolving
 *        to nothing, which is a subject with no spelling to quote and so the
 *        one thing the wording says differently.
 */
[[nodiscard]] std::string describe_empty_header_name (const std::string& written);

/// The `POST /compose` refusal code each rule answers under, beside its wording
/// for the same reason: a layer with no `400` of its own still names the rule by
/// one - a streaming send reports the residual pass's refusal as a `400`, and a
/// code spelled at that site is a code that drifts from the rule it names.
inline constexpr std::string_view COLLIDING_HEADER_NAMES_CODE =
"colliding_header_names";
inline constexpr std::string_view EMPTY_HEADER_NAME_CODE = "empty_header_name";

} // namespace vayu::http

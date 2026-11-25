#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <map>
#include <optional>
#include <string>
#include <string_view>

// For `Headers`, whose comparison `HeaderNameOrigins` is keyed by rather than
// naming a second one of its own.
#include "vayu/types.hpp"

/**
 * @brief What a header *name* can be, and what resolution can do to one - the
 *        rules, one place.
 *
 * Three of them. Two are about a name a variable produced rather than one the
 * author typed: two names that become one (below), and a name that becomes
 * nothing (`describe_empty_header_name`). Neither is visible from the response,
 * and nothing further down the send catches either. The third is about any
 * name, typed or produced: once its surrounding spaces and tabs are trimmed it
 * must be an RFC 9110 token (`trim_optional_whitespace`,
 * `invalid_header_name_refusal`, "The name that is not a token" below).
 *
 * A header name is substituted like any other field, so two names can resolve
 * to one. `{{tenant_header}}: acme` beside a literal `X-Tenant: legacy` would
 * send `X-Tenant` twice, and names compare case-insensitively, so a `{{h}}`
 * resolving to `authorization` would send a second credential beside the typed
 * `Authorization`.
 *
 * That is the same quiet wrong request the header-text rule refuses in
 * `header_text.hpp`: there a value *forges* a header, here a value *repeats*
 * one the author did not repeat. Both are a request the author did not write.
 *
 * ## Refusal, never repair
 *
 * (For the two rules about *produced* names. The third trims, and says why
 * under its own heading.)
 *
 * Which of the two names survives has no honest answer: they are equally the
 * author's. Sending both is what libcurl would do, since its header list
 * carries any number of lines under one name (#2466), but then the request
 * carries a repeated header no row in the editor shows. So the request is
 * refused, and the message names both headers as written: the pair the author
 * has to look at. It never repeats the name they produced: what a variable
 * produced can be a secret, and a refusal reaches whoever reads the run.
 *
 * ## Which collisions this is about
 *
 * Only the ones **resolution produced**: two names *written* differently that
 * come out as one (`record_produced_name`). Two names written alike - `X-Dup`
 * and `x-dup` typed on two rows, or one `{{h}}` typed twice - are a repeated
 * header the author can see side by side, and every one of those lines is sent,
 * in order (#2466). A collision substitution made is invisible until the
 * request comes back wrong; that is the whole difference.
 *
 * ## Where the rule is enforced
 *
 * One rule, enforced wherever a name is bound or resolved, each layer naming
 * what it alone knows - the shape `header_text.hpp` describes for its own. The
 * bullets are the count: a number spelled out here would go stale when a layer
 * is added.
 *
 * - **A bound data cell** (`core/scenario_data.cpp`, #732) refuses at bind
 *   time, naming the column and the row, in its own words because only it knows
 *   the row.
 * - **A composed `{{variable}}`** (`http/request_composer.cpp`, #1051) refuses
 *   at composition with a `400`, naming both spellings.
 * - **The residual pass** (`http/request_exchange.cpp`, #1008) refuses in the
 *   same words at execute time, where a name a pre-request script has just
 *   defined can collide with one composition resolved. It has no `400` to
 *   return, so it refuses the send the way the pre-send gate does - see
 *   `resolve_residual_tokens`.
 * - **A script's own `pm.sendRequest`** (`runtime/pm/pm_send_request.cpp`,
 *   #1067) refuses in the same words with the call named in front, because that
 *   send is the script's rather than the request's - see
 *   `resolve_send_request_headers`. It throws where the others refuse, since a
 *   script asked for the send and a throw is what it can catch.
 *
 * The pre-send gate cannot be the backstop, which is why the rule is enforced
 * where a name is resolved: by the time the gate sees a request, the names are
 * resolved and a produced repeat looks exactly like a typed one.
 *
 * ## The name that resolves to nothing
 *
 * `describe_empty_header_name` is the second rule, the same argument one step
 * further: `{{blank}}: acme` with `blank` empty is not a header the author can
 * see either, and the gate is no backstop for the same reason - it reads header
 * text for the bytes that break a line, and an empty name breaks nothing. What
 * is left goes out as the line `": acme"`, under no name at all. The three
 * layers that resolve a name refuse it - composition, the residual pass (#1084)
 * and `pm.sendRequest` (#1067), whose script writes header names of its own -
 * and so does the one that *binds* a name from a data row (#1095, below).
 *
 * Unlike a collision, composition refuses this one however the name got there:
 * two typed names are two lines the author can see, but a name that is not
 * there is nothing to see whoever wrote it. Both flattenings that feed
 * composition (the stored one and the renderer's) drop such a row before it
 * arrives, so beyond a produced name this catches a caller that built the
 * payload itself.
 *
 * **Every layer that can leave a header nameless refuses it** (#1095), the same
 * four the collision rule is enforced in. All four use the one wording below,
 * where the collision rule's bind layer words its own, and the residual pass
 * reads wider for this rule than for that one:
 *
 * - **A bound data cell** refuses it at bind time, in these words with the row
 *   in front - a blank cell is an ordinary thing for a data file to hold, and
 *   the load path runs no residual pass, so this is the layer or nothing. It
 *   words the *collision* itself because that message names what the bound name
 *   collided with; this one has only the row to add.
 * - **The residual pass** reads every name for this rule, not only the
 *   templated ones, so a name a script has just emptied and a payload posted
 *   straight to `POST /execute` carrying an empty key are both refused. The
 *   collision rule keeps the narrower reach and loses nothing by it: a request
 *   that arrives already resolved carries no written name that differs from
 *   what it sends, so every repeat in it is a repeat as written.
 *
 * ## The name that is not a token (#2467)
 *
 * `Authorization ` with a trailing space is a header name no one meant: the
 * wire line `Authorization : Bearer x` has a space before its colon, which a
 * strict server answers `400` and a lenient one reads as a header of another
 * name. So a name is **trimmed** of the SP and HTAB around it - a paste error
 * with one reading, the repair every client makes for a field's leading and
 * trailing blanks - and the result must be an RFC 9110 `token`
 * (`invalid_header_token`, `default_headers.hpp`). Whatever is left over - an
 * interior space, a colon, a byte outside ASCII - has no single intended
 * reading, so it is **refused** (`INVALID_HEADER_NAME_CODE`), never rewritten
 * into a different header: trimming is for what has one reading, refusal for
 * what has none.
 *
 * A name that is only whitespace trims to nothing and is the empty-name rule's
 * (`EMPTY_HEADER_NAME_CODE`): there is no spelling left to quote. In a name
 * still holding a `{{token}}` the token is set aside, not the name: `{` is not
 * a token character, but a token nothing answered is sent as written (#1009),
 * so each token stands in as one token character and the text around it is
 * judged like any other (`X-{{a}}-b` passes, `X Bad {{x}}` and
 * `Evil: injected{{` do not). A `{{` that closes no token is ordinary text. A
 * layer that resolves later (the residual pass) judges the name it produces.
 *
 * Enforced wherever a name enters, each layer in its own words only where it
 * alone knows something:
 *
 * - **The stored rows composition flattens** are trimmed there
 *   (`stored_header_rows`; the renderer's `toHeaderRows` is the other copy).
 * - **A composed name** (`http/request_composer.cpp`) is judged after its
 *   variables resolve.
 * - **The `headers` of a `POST /execute` or `POST /runs` payload**
 *   (`utils/json.cpp`) are judged as the payload is read, and
 *   `ErrorCode::InvalidHeaderName` carries the refusal to the route that
 *   answers it.
 * - **The residual pass** (`http/request_exchange.cpp`) judges what it
 *   resolves, and reads every name for it, as for the empty one: the layer that
 *   meets a name a pre-request script has just defined.
 * - **A bound data cell** (`core/scenario_data.cpp`) is judged at bind time
 *   with the row in front of the message, since the load path runs no residual
 *   pass.
 * - **A script's own `pm.sendRequest`** (`runtime/pm/pm_send_request.cpp`)
 *   throws it with the call named in front.
 *
 * The refusals quote the name as written, never what a variable made of it: a
 * refusal travels to whoever reads the run, and a variable can hold a secret.
 * The offending byte is the one thing about the produced name a message says.
 *
 * An auth credential is trimmed of the same set, and an API key's header name
 * judged by the same rule (`http/auth_resolver.cpp`).
 */

namespace vayu::http {

/// Two header names that became one when `{{variables}}` were resolved into
/// them.
struct HeaderNameCollision {
    /// One of the two names as the request carries it, before resolution - the
    /// text the author has to go and fix.
    std::string written;
    /// The other one, also as written. Which of the two is which follows the
    /// order the names were walked in and carries no meaning: neither is more
    /// at fault than the other, which is why neither is repaired.
    std::string other;
    /// The one name they both landed on. No message of this header's quotes it
    /// (see `describe_header_name_collision`); a layer whose variables are
    /// data-file cells rather than secrets may.
    std::string produced;
};

/**
 * @brief Each name resolution produced, against the name as written that first
 * produced it.
 *
 * What a layer resolving header names keeps beside the lines it builds, because
 * a collision has to be named with both spellings and is told apart from a
 * typed repeat by them (`record_produced_name`).
 *
 * Keyed by `Headers`' own comparison rather than by a comparator named again
 * here, so "the same header name" means one thing everywhere. It is
 * deliberately not a `Headers` itself: its value is a header name, never a
 * header value.
 */
using HeaderNameOrigins = std::map<std::string, std::string, Headers::key_compare>;

/**
 * @brief Note that @p written resolved to @p produced, and answer the
 *        collision when a name written *differently* already produced it.
 *
 * Nothing for the first name to produce @p produced, and nothing for a later
 * one written alike (compared without case): that is a repeat the author typed,
 * which is sent.
 */
[[nodiscard]] std::optional<HeaderNameCollision> record_produced_name (HeaderNameOrigins& origins,
const std::string& produced,
const std::string& written);

/**
 * @brief The refusal a header-name collision reads as.
 *
 * One wording for every layer that resolves a name - composition, the residual
 * pass and a script's own `pm.sendRequest` - because they are one rule, and
 * three wordings would read as three rules. A layer may name itself in front of
 * the wording, never inside it.
 */
[[nodiscard]] std::string describe_header_name_collision (const HeaderNameCollision& collision);

/**
 * @brief The refusal a header name that resolved to nothing reads as.
 *
 * One wording for four layers - the three above and the bind, which words its
 * own collision message - on the same reasoning: a caller meeting this at
 * composition, at execute time and from a data row meets one rule, and four
 * spellings would read as four. A layer may name itself in front of the
 * wording, never inside it.
 *
 * @param written the name as the request carries it, before resolution: the
 *        whole of what the message can name, since what it produced is nothing
 *        and `{{blank}}` is what the author has to look at. Empty for a name
 *        that arrived empty rather than resolving to nothing: no spelling to
 *        quote, the one thing the wording says differently.
 */
[[nodiscard]] std::string describe_empty_header_name (const std::string& written);

/// The `POST /compose` refusal code each rule answers under, beside its wording
/// for the same reason: a layer with no `400` of its own still names the rule by
/// one - a streaming send reports the residual pass's refusal as a `400`, and a
/// code spelled at that site is a code that drifts from the rule it names.
inline constexpr std::string_view COLLIDING_HEADER_NAMES_CODE =
"colliding_header_names";
inline constexpr std::string_view EMPTY_HEADER_NAME_CODE = "empty_header_name";
inline constexpr std::string_view INVALID_HEADER_NAME_CODE =
"invalid_header_name";

/// SP and HTAB: RFC 9110's optional whitespace, the only padding a header name
/// or a credential is trimmed of. CR, LF and NUL are not padding - they end or
/// cut the line, which `header_text.hpp` refuses.
inline constexpr std::string_view OPTIONAL_WHITESPACE = " \t";

/// @p text without the SP and HTAB at either end; interior ones stay.
[[nodiscard]] std::string_view trim_optional_whitespace (std::string_view text);

/**
 * @brief The refusal a header name that is not a token reads as, or nothing
 *        for one that is.
 *
 * @p name is the name as it will be sent: already trimmed
 * (`trim_optional_whitespace`) and not empty - an empty one is
 * `describe_empty_header_name`'s. A `{{token}}` in it is not judged, the text
 * around it is (see the rule above). One wording for every layer that reads a
 * name, on the same reasoning as the two above: a layer may name itself in
 * front of it, never inside it.
 *
 * @p written is the name as the request carries it, before this layer resolved
 * it, and is the only name the message quotes: what a variable produced can be
 * a secret, and a refusal travels to whoever reads the run. For a name nothing
 * resolved, pass @p name again. Empty quotes nothing - for a layer that was
 * handed the resolved name and never had the written one (`API key auth`). The
 * message always says which byte cannot appear, which is the one thing about
 * the produced name it repeats.
 */
[[nodiscard]] std::optional<std::string>
invalid_header_name_refusal (std::string_view name, std::string_view written);

} // namespace vayu::http

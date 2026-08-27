#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/scenario_data.hpp
 * @brief Bind a data row into a composed request through the reserved
 *        `{{data.column}}` namespace (issue #402).
 *
 * `pm.iterationData` (#356) gave *scripts* the row. It cannot make the row
 * influence the request itself, because a scenario plan is composed once,
 * before the first send, and a script that reads a row after the request was
 * built is reading it too late to change where it goes. `{{data.column}}` is
 * the other half: the token survives composition (`http::is_data_variable_name`
 * keeps it written as it stands) and this module substitutes it per iteration,
 * against that iteration's row.
 *
 * **The namespace is reserved, not another tier.** `{{data.id}}` and `{{id}}`
 * are different names, so a data set can never shadow - or be shadowed by - a
 * global, collection or environment variable. That is what makes the feature
 * safe to add to collections people already have.
 *
 * A column the row does not carry is an **error, not an empty string**: the
 * whole point of the token is that the value came from the file, and sending a
 * request with a silently blank field is the failure mode this namespace
 * exists to remove. The runner turns that into an errored step, before the
 * request is sent.
 *
 * A run started with **no data set at all** is the same failure one step
 * earlier, and is refused one step earlier too: plan resolution tokenises the
 * composed steps and returns a `400` rather than starting a run whose every
 * iteration would send the literal token (issue #415).
 *
 * A cell that is **null** is the same failure again, one type down: the token
 * says the value comes from the file and the file says there is none, so the
 * bind errors rather than writing nothing where a value belonged (issue #593).
 *
 * Two header names that **bind to the same name** are the same failure once
 * more, one field over: `X-{{data.h}}` resolving to `authorization` beside a
 * literal `Authorization` would leave a map with one of them in it, so the bind
 * errors rather than dropping a header (issue #595). Composition's duplicate
 * rule is last-wins, and this deliberately is not: a duplicate there is two
 * headers the user typed and can see, while this one exists only for the rows
 * that produce it - a file whose row 3 collides sends two good requests and
 * then one quietly missing its auth.
 *
 * A cell carrying a **CR or LF bound into a header** is the same failure once
 * more, on the same field (issue #732). A header line ends at CRLF, so a cell
 * holding `ok\r\nX-Admin: true` does not put that text in the header - it ends
 * the header and makes the remainder a header of its own, which is a request
 * the file's author never wrote. There is no escape for a line break in a
 * header, so unlike a quote in a JSON body this cannot be encoded around: the
 * bind errors. It covers a header name, a header value, and a credential
 * `apply_auth` writes into a header line (a bearer token, an api key sent in a
 * header) - not basic auth's pair or an api key sent in the query, whose bytes
 * are base64- and percent-encoded before they reach the wire.
 *
 * ## A value is written for the document it lands in
 *
 * Substitution is textual, so a value carrying a `"` used to end the JSON
 * string it was dropped into and put a malformed body on the wire, silently
 * (issue #593). A token inside a string literal of a JSON body therefore binds
 * **escaped**: the cell's text stays what it was, and the document stays
 * readable. A token placed *outside* a string literal - `{"n":{{data.n}}}` -
 * still binds verbatim, which is what makes typed placement work.
 *
 * An `xml` body is a document with a quoting rule too, and not JSON's (issue
 * #618): a cell holding `Ben & Jerry's` used to go out byte for byte and make
 * the document malformed, and one holding `</customer><injected/>` used to
 * change its shape. The rule depends on *where* the token sits, which is more
 * than a single bit can say - character data and an attribute value escape
 * different sets, a CDATA section escapes nothing, and a comment or a
 * processing instruction has no right answer at all and is refused. The
 * position is scanned at split time, from the same literals the JSON scan
 * reads.
 *
 * Nothing else is escaped: a URL, a header, a form field and a text body take
 * the rendered value byte for byte, because none of them is a document with a
 * quoting rule of its own.
 *
 * ## Split once, joined per row
 *
 * A step is tokenised when the plan is resolved (`tokenize_data_fields`) and
 * only *joined* afterwards (`apply_data_template`). Design mode could afford to
 * re-scan every field per iteration; the load-mode executor cannot, because it
 * binds a row per iteration per virtual user (issue #449). Both modes drive the
 * same template rather than one keeping a scanner of its own, so a step binds
 * identically however it is executed.
 *
 * ## Credentials are bound before they are encoded
 *
 * A credentials file driving basic auth is the canonical data-driven run, and
 * the fields above cannot serve it: `apply_auth` collapses a username and a
 * password into one base64 `Authorization` value, so a `{{data.user}}` resolved
 * into the plan is already unreadable by the time anything scans the built
 * request - it went out as base64 of the literal token text, silently (issue
 * #591). `tokenize_auth_fields` therefore splits the *typed* credentials
 * instead, and a step that carries one binds them and applies its auth per
 * iteration rather than at plan time.
 */

#include <cstddef>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/** Whether a row bound cleanly, and what was wrong when it did not. */
struct DataBindResult {
    bool ok = false;
    /// Caller-facing sentence naming the token, the row and the row's columns.
    /// Reaches `results.error` and the app's step list, so it has to be enough
    /// to fix the request without opening the file.
    std::string error;
};

/**
 * How one token's rendered value is written into the text around it.
 *
 * Decided at split time, per token, because the surrounding literals are what
 * answer it and they do not change per row - the join must not re-derive this
 * for every iteration of every virtual user.
 */
enum class DataValueEncoding : std::uint8_t {
    /// The rendered text, byte for byte. Every field that is not a document
    /// with a quoting rule - and, inside an XML body, a token sitting in markup
    /// rather than in content (see @ref XmlText).
    Verbatim,
    /// Escaped as JSON string content (`"`, `\` and the control characters),
    /// for a token sitting inside a string literal of a JSON body.
    JsonString,
    /// Escaped as XML character data (`&`, `<`, `>`), for a token sitting
    /// between tags of an `xml` body.
    XmlText,
    /// @ref XmlText plus the `"` that would end the attribute value the token
    /// sits in.
    XmlAttributeDouble,
    /// @ref XmlText plus the `'` that would end the attribute value the token
    /// sits in.
    XmlAttributeSingle,
    /// Verbatim inside a `<![CDATA[…]]>` section - which is what the section
    /// means - except for a `]]>` in the value, which would end it early.
    XmlCdata,
    /// Not writable: the token sits inside an XML comment. The join refuses the
    /// row rather than guessing, because every candidate encoding is wrong -
    /// see `advance_xml_state`.
    XmlInComment,
    /// Not writable: the token sits inside an XML processing instruction.
    XmlInProcessingInstruction,
};

/**
 * Which reserved namespace a template's tokens were split from.
 *
 * The two are the same machinery over different names, which is why they are a
 * flag rather than two field lists: both survive composition, both are bound by
 * the executor immediately before a send, and both write their value through
 * the encodings the split decided. What differs is only how a token is spelled
 * back into an error and what the value is bound *from* - a row of the data
 * set, or the iteration that is sending.
 */
enum class TokenNamespace : std::uint8_t {
    /// `{{data.column}}` - a column of the run's data set (issue #402).
    Data,
    /// `{{$vu}}` / `{{$iteration}}` - the identity of the iteration that is
    /// about to send (issue #994).
    Identity,
};

/** One bindable field, split once around the `{{data.column}}` it carries. */
struct DataFieldTemplate {
    /// Which string this is, counted in `walk_bindable_fields` order. Both the
    /// split and the join drive that one walk, so neither can address a field
    /// the other does not - the same reason the scan and the bind shared it.
    size_t field = 0;
    /// `literals.size() == columns.size() + 1`; see `http::TokenSplit`.
    std::vector<std::string> literals;
    /// The column names, with the `data.` prefix already stripped.
    std::vector<std::string> columns;
    /// One per entry of `columns`, in the same order.
    std::vector<DataValueEncoding> encodings;
};

/**
 * A step's bindable fields, tokenised once.
 *
 * **Empty for a step carrying no `{{data.*}}` token at all**, and that
 * emptiness is what a token-free plan is charged per iteration: the executor
 * skips the join outright rather than walking fields that cannot change.
 */
struct StepDataTemplate {
    /// Only the fields that carry at least one token, in walk order.
    std::vector<DataFieldTemplate> fields;
    /// Which namespace @ref fields were split from, so an error can spell a
    /// token back the way it was written. Data by default, because that is what
    /// every caller predating the identity namespace splits.
    TokenNamespace ns = TokenNamespace::Data;

    [[nodiscard]] bool empty () const noexcept {
        return fields.empty ();
    }

    /**
     * The first `{{data.column}}` token in walk order, written back with its
     * braces (`{{data.id}}`), or `nullopt` for a step that carries none.
     *
     * This is what lets plan resolution refuse a run whose steps carry data
     * tokens and whose payload has no `data` set (issue #415): nothing would
     * bind them, so they would reach the wire written as they stand.
     */
    [[nodiscard]] std::optional<std::string> first_token () const;
};

/**
 * Split every bindable field of @p request around its `{{data.column}}` tokens.
 *
 * Run once per step, when the plan is resolved. The request is copied for it -
 * the shared walk rewrites in place and nothing is actually rewritten here -
 * which is affordable exactly because resolution happens once per run, over a
 * plan already bounded by `maxScenarioSteps`.
 *
 * The body's **mode** is read here as well as its text: it is what decides
 * whether the body is a JSON or an XML document, and so how each of its tokens
 * binds. A template is therefore only valid for a request whose body mode is
 * the one it was split from.
 */
[[nodiscard]] StepDataTemplate tokenize_data_fields (const vayu::Request& request);

/**
 * Join @p tmpl's fields against @p row, in place on @p request.
 *
 * @p tmpl must have been built from a request of the same shape (in practice:
 * from the plan step @p request was copied from), because a field is addressed
 * by its position in the walk.
 *
 * Fails for a column @p row does not carry, a column whose cell is `null`, a
 * cell whose value would end the header line it is bound into, two
 * header names that bound to one name, and a token placed where an `xml` body
 * has no encoding that would keep the document meaning what it says - inside a
 * comment or a processing instruction. That last one fails for every row alike,
 * because it is the template's fault rather than the row's, and is reported
 * before the row is even consulted.
 *
 * On failure @p request is left partially bound and must not be sent - the
 * caller ends the step. Repairing it would mean a second copy of the composed
 * request per step per iteration for a path that never reaches the wire.
 */
[[nodiscard]] DataBindResult apply_data_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index);

/**
 * Which iteration of which virtual user is about to send (issue #994).
 *
 * Both numbers already exist wherever a request is sent - a scenario load run's
 * `VirtualUser` holds them, a single-request run counts its submissions, a
 * design-mode send is a run of one - so this carries them to the bind rather
 * than inventing a second source of truth for either.
 */
struct IterationIdentity;

/**
 * The virtual user every send outside a scenario *load* run belongs to.
 *
 * One request repeated under load, a collection walked in design mode and a
 * plain Send are all one user's iterations, whatever their concurrency:
 * `concurrency` says how many of that user's iterations are in flight at once,
 * which is a different question from how many users there are. Virtual users
 * that differ from one another are a scenario load run's own shape, and that is
 * the run where `{{$vu}}` spans more than this (issue #994).
 */
inline constexpr size_t SOLE_VIRTUAL_USER = 1;

struct IterationIdentity {
    /// The virtual user, **1-based**: the first user of a run is `1`, so
    /// `user-{{$vu}}@example.com` reads as a person would number them.
    size_t vu = 1;
    /// That virtual user's iteration, **0-based**, so it indexes the data set
    /// the same way `{{data.*}}`'s row cursor does.
    size_t iteration = 0;
};

/**
 * Split every bindable field of @p request around its `{{$vu}}` and
 * `{{$iteration}}` tokens - `tokenize_data_fields` over the identity namespace.
 *
 * **Empty for the overwhelming majority of requests**, which carry neither
 * token, and that emptiness is what the identity costs a run that does not use
 * it: one `empty()` test per iteration and no walk at all.
 *
 * Run once per run (a single request) or per step (a plan), never per
 * iteration - the same bargain the data namespace makes, and for the same
 * reason: a load run binds at its full rate.
 */
[[nodiscard]] StepDataTemplate tokenize_identity_fields (const vayu::Request& request);

/**
 * Join @p tmpl's fields against @p identity, in place on @p request.
 *
 * The identity is a row of two reserved columns rather than a second joiner:
 * the values are written into the field, escaped for the document they land in
 * and refused where no encoding fits, by exactly the code a data row goes
 * through - so a `{{$vu}}` inside a JSON string cannot be escaped differently
 * from a `{{data.id}}` beside it.
 *
 * Cannot fail on the identity's own account - both names always have a value -
 * so the failures left are the template's: a token placed inside an XML comment
 * or processing instruction, and two header names that bound to one name. On
 * failure @p request is left partially bound and must not be sent, which is
 * `apply_data_template`'s rule inherited whole.
 */
[[nodiscard]] DataBindResult apply_identity_template (vayu::Request& request,
const StepDataTemplate& tmpl,
IterationIdentity identity);

/**
 * Split @p auth's credential strings around their `{{data.column}}` tokens.
 *
 * The same splitter the request walk drives, over `walk_auth_credentials`
 * instead of `walk_bindable_fields` - one field list per walk, and the join
 * below drives the identical walk, so neither can address a credential the
 * other does not.
 *
 * Every credential binds **verbatim**: a token, a username and an api key are
 * plain text, not a document with a quoting rule, and what escaping they need
 * (base64 for basic auth, percent-encoding for an api key in the query) is
 * `apply_auth`'s to add *after* the bind - which is the whole point of binding
 * before the auth is applied.
 *
 * Verbatim is not unchecked: a credential `apply_auth` writes into a header
 * line takes the header rule above, so a cell holding a CR or LF is refused
 * there too. `walk_auth_credentials` says which credential that is, per
 * `http::CredentialDestination`, because the destination is a property of the
 * auth mode rather than of the string.
 *
 * Empty for the ordinary step, whose credentials carry no token and whose auth
 * is therefore resolved into the plan once, as it always was.
 */
[[nodiscard]] StepDataTemplate tokenize_auth_fields (const vayu::http::Auth& auth);

/**
 * Join @p tmpl's credentials against @p row, in place on @p auth.
 *
 * @p auth must be the parsed auth @p tmpl was split from, for the same reason
 * `apply_data_template` needs the request it was split from: a credential is
 * addressed by its position in the walk.
 */
[[nodiscard]] DataBindResult apply_auth_data_template (vayu::http::Auth& auth,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index);

/**
 * Bind @p auth's credentials against @p row and apply the result to @p request.
 *
 * The whole deferred-credential sequence in one place - join, then apply - for
 * every caller that built its request with `http::AuthResolution::Defer`. Both
 * of them drive this: a scenario step binds it per iteration through
 * `bind_step_auth`, and a single send binds it once
 * (`POST /execute` with a `data` row, issue #642). A second copy of the order
 * would be a copy that stops receiving this one's fixes, and the order is the
 * entire point - the row has to reach the credentials before `apply_auth`
 * base64-encodes them.
 *
 * @p auth is taken **by value**: the join rewrites credentials in place, and a
 * plan's step auth is shared, immutable and re-bound by every virtual user.
 *
 * A no-op returning success for an empty @p tmpl, so a caller may call it
 * unconditionally. Note that this makes an empty template mean "these
 * credentials carry no row values" and *not* "apply this auth" - a caller that
 * deferred a build must only have done so for a non-empty template.
 *
 * No database handle reaches `apply_auth`: oauth2 is the only mode that needs
 * one, and an oauth2 config carrying a data token is refused before any build
 * is deferred (@ref first_oauth2_data_token).
 */
[[nodiscard]] DataBindResult bind_auth_row (vayu::Request& request,
vayu::http::Auth auth,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index);

/**
 * One iteration's whole bind, in the order that makes it correct: @p fields
 * into @p request, then @p credentials into the auth applied on top of it.
 *
 * The order is the point, and it is why this is one function rather than two
 * calls each executor makes in sequence: a credential has to carry the row's
 * value *before* `apply_auth` base64-encodes it (issue #591), so a caller that
 * bound them the other way round would send base64 of the literal token text -
 * the failure that is invisible once encoded. Both load executors drive this,
 * so a request cannot bind differently depending on whether it was repeated on
 * its own or as a step of a sequence.
 *
 * A no-op returning success when both templates are empty, so a caller may call
 * it unconditionally. @p auth is only read when @p credentials is non-empty,
 * which is exactly when the request's build was deferred; a caller whose auth
 * was applied at build time passes its `NoAuth` and pays nothing.
 *
 * On failure @p request is left partially bound and must not be sent - see
 * `apply_data_template`, whose rule this inherits.
 */
[[nodiscard]] DataBindResult bind_iteration_row (vayu::Request& request,
const StepDataTemplate& fields,
const vayu::http::Auth& auth,
const StepDataTemplate& credentials,
const nlohmann::json& row,
size_t row_index);

/**
 * The first `{{data.column}}` in any string of @p value, recursively, written
 * back with its braces - or `nullopt` when it carries none.
 *
 * For a block that has no bind to offer at all and must therefore refuse rather
 * than defer: an OAuth 2.0 config, whose token is acquired once when the plan
 * is resolved. Object *keys* are not scanned - a column name where a config key
 * belongs is not a placement anyone means.
 */
[[nodiscard]] std::optional<std::string> first_data_token_in (const nlohmann::json& value);

/**
 * The first `{{data.column}}` in @p auth's OAuth 2.0 configuration, or
 * `nullopt` - for any other mode as well as for an oauth2 config carrying none.
 *
 * **OAuth 2.0 is the one mode deferral cannot serve**, and this is the check
 * that says so, for both callers that defer. Its token is acquired against the
 * token endpoint once - when a plan is resolved, or before a single send leaves
 * - so there is no later moment at which a row could reach the acquisition, the
 * way binding a credential before `apply_auth` encodes it reaches every other
 * mode. Refused by name rather than sent to the token endpoint as the literal
 * token text.
 *
 * Every other mode's credentials are walked by `walk_auth_credentials` and
 * bound; an oauth2 config is deliberately absent from that walk, which is why
 * it needs this second, config-shaped scan.
 */
[[nodiscard]] std::optional<std::string> first_oauth2_data_token (
const vayu::http::Auth& auth);

/**
 * `render_data_value` moved to `http/request_composer.hpp` (issue #890).
 *
 * It is the `data.` namespace's own spelling rule, and the namespace lives in
 * the composer beside `DATA_NAMESPACE_PREFIX` and `is_data_variable_name`. The
 * script sandbox needs it too - `pm.variables.replaceIn` resolves the namespace
 * now - and the runtime layer sits *below* core, so leaving it here would have
 * meant a second copy of a five-line rule. Use `vayu::http::render_data_value`.
 */

/**
 * Substitute every `{{data.column}}` in @p request against @p row, in place -
 * tokenising it first, for a caller that holds no template.
 *
 * Covers exactly what composition covered: the URL, header names and values,
 * the raw body, and both halves of every form field. @p row_index names the
 * row in an error, because with `iterations` above the row count the bound row
 * is not the iteration number.
 *
 * A caller binding the *same* request repeatedly - every load-mode iteration of
 * every virtual user - must hold the template instead and call
 * `apply_data_template`, which is the whole point of splitting once.
 */
[[nodiscard]] DataBindResult
bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index);

} // namespace vayu::core

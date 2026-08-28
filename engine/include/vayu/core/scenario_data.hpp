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
 * **A bound row answers for bare column names too** (issue #1007), and that one
 * *is* a tier - the highest, and only while a row is bound. Postman writes a
 * dataset's columns bare, so every imported data-driven collection spells them
 * `{{username}}`, and a run that answered those from the scopes (or from
 * nowhere) sends a request the file's author never wrote. Which bare names a
 * bind owns is decided where the dataset is known and travels as
 * `http::BoundColumnNames`: composition leaves those tokens written as it
 * stands, exactly as it does the reserved ones, and this module joins both
 * spellings against the row through the same walk - so the escaping, the
 * missing-column refusal, the null-cell refusal and the header rules below hold
 * for a bare column identically. A file bound to a run cannot reach the wire
 * through a path with fewer rules than the prefixed spelling has.
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
 * A step is tokenised when the plan is resolved (`tokenize_bindable_fields`)
 * and only *joined* afterwards (`apply_iteration_template`). Design mode could afford to
 * re-scan every field per iteration; the load-mode executor cannot, because it
 * binds a row per iteration per virtual user (issue #449). Both modes drive the
 * same template rather than one keeping a scanner of its own, so a step binds
 * identically however it is executed.
 *
 * ## A generator belongs to the send, not to the composition
 *
 * `{{$guid}}` and its family are generated by composition (issue #186's table),
 * and a run composes once and sends many times - so the same id used to reach
 * the wire on every request of every virtual user, which is the opposite of
 * what a unique-id token is written for (issue #995). A composition that knows
 * its payload will be repeated therefore *defers* the family instead
 * (`http::DynamicResolution::Defer`): the token survives exactly as
 * `{{data.column}}` does, is split into the template below, and is generated
 * per iteration by the same join. Nothing else changes about it - the value is
 * fresh per occurrence and written for the document it lands in, so it is
 * escaped inside a JSON string and refused inside an XML comment on the same
 * rules a cell is.
 *
 * What a run that spells no generator pays for this is nothing: composition
 * substituted nothing, so the split finds nothing and the template stays empty.
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
#include "vayu/http/request_composer.hpp"
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
 * One bindable field, split once around the reserved tokens it carries.
 *
 * **One list, every namespace.** `{{data.id}}`, `{{$vu}}` and a deferred
 * `{{$guid}}` (issue #995) are bound at the same moment by the same walk, and a
 * field may hold one of each - so they are split together and joined together.
 * Two templates over one field could not be: each join rebuilds the whole field
 * from its own literals, so the second would write back the text the first
 * started from, silently undoing it.
 */
struct DataFieldTemplate {
    /// Which string this is, counted in `walk_bindable_fields` order. Both the
    /// split and the join drive that one walk, so neither can address a field
    /// the other does not - the same reason the scan and the bind shared it.
    size_t field = 0;
    /// `literals.size() == tokens.size() + 1`; see `http::TokenSplit`.
    std::vector<std::string> literals;
    /// The token names **as they were written**, braces stripped and the
    /// namespace kept: `data.id`, `$vu`, `$guid`, and a bare column name a
    /// bound row answers (issue #1007). Kept whole because the name is what
    /// says where the value comes from, and what an error has to quote back.
    std::vector<std::string> tokens;
    /// One per entry of @ref tokens, in the same order.
    std::vector<DataValueEncoding> encodings;
};

/**
 * A step's bindable fields, tokenised once.
 *
 * **Empty for a step carrying no reserved token at all**, and that emptiness is
 * what a token-free plan is charged per iteration: the executor skips the join
 * outright rather than walking fields that cannot change.
 */
struct StepDataTemplate {
    /// Only the fields that carry at least one token, in walk order.
    std::vector<DataFieldTemplate> fields;

    [[nodiscard]] bool empty () const noexcept {
        return fields.empty ();
    }

    /**
     * The first data token in walk order, written back with its braces
     * (`{{data.id}}`, or `{{id}}` for a bare one), or `nullopt` for a step that
     * carries none.
     *
     * This is what lets plan resolution refuse a run whose steps carry data
     * tokens and whose payload has no `data` set (issue #415): nothing would
     * bind them, so they would reach the wire written as they stand. A bare
     * column name (issue #1007) is not one of these: it can only have been
     * split against a set of bound names, so a run with no data set carries
     * none of them to refuse.
     *
     * Deliberately blind to `{{$vu}}` / `{{$iteration}}` and to a deferred
     * generator (issue #995), which share this template: neither needs a data
     * set behind it, so a plan carrying only those is perfectly runnable and
     * must not be refused by this check.
     */
    [[nodiscard]] std::optional<std::string> first_data_token () const;
};

/**
 * The bare column names a bound row - or a whole dataset - can substitute
 * (issue #1007).
 *
 * One definition rather than a keys-walk per caller, because every path that
 * binds rows needs the same set and a path that built it differently would bind
 * a different request: the single send takes its one row's keys, and a run
 * takes the union over its rows, so a column only some rows carry is still
 * split - and refused per row by the missing-column rule, which is the answer
 * the reserved spelling has always given.
 *
 * A non-object row contributes nothing; `read_data_rows` has already refused
 * one by the time a run holds it, and the single send's reader does the same.
 */
[[nodiscard]] vayu::http::BoundColumnNames bound_columns_of (const nlohmann::json& row);

/** @copydoc bound_columns_of(const nlohmann::json&) */
[[nodiscard]] vayu::http::BoundColumnNames bound_columns_of (
const std::vector<nlohmann::json>& rows);

/**
 * Which iteration of which virtual user is about to send (issue #994).
 *
 * Both numbers already exist wherever a request is sent - a scenario load run's
 * `VirtualUser` holds them, a single-request run counts its submissions, a
 * design-mode send is a run of one - so this carries them to the bind rather
 * than inventing a second source of truth for either.
 */
struct IterationIdentity {
    /// The virtual user, **1-based**: the first user of a run is `1`, so
    /// `user-{{$vu}}@example.com` reads as a person would number them.
    size_t vu = 1;
    /// That virtual user's iteration, **0-based**, so it indexes the data set
    /// the same way `{{data.*}}`'s row cursor does.
    size_t iteration = 0;
};

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

/**
 * Everything one iteration substitutes into the request it is about to send:
 * its row, where the run has a data set, and its identity, which every run has.
 *
 * One argument rather than two, because a caller must not be able to bind half
 * of it - a field holding `{{data.id}}` beside `{{$vu}}` is joined once, from
 * both sources at once.
 */
struct IterationBinding {
    /// This iteration's row, or **null for a run sent without `data`**. Points
    /// into the run's own rows, which outlive the bind.
    const nlohmann::json* row = nullptr;
    /// Which row that is, for an error to name. Meaningless when @ref row is
    /// null, and read by nothing in that case.
    size_t row_index = 0;
    /// Who is sending, which is known even when there is no row at all.
    IterationIdentity identity;
};

/**
 * Split every bindable field of @p request around its reserved tokens -
 * `{{data.column}}` (issue #402), `{{$vu}}` / `{{$iteration}}` (issue #994),
 * every bare name @p bound_columns says a row will substitute (issue #1007),
 * and every generator name composition left written as it stands (issue #995).
 * The bare names are empty for every run with no dataset behind it, and the
 * generators are absent from anything a Send composed, which is what keeps the
 * split for those exactly the scan it always was.
 *
 * Run once per step, when the plan is resolved, or once per run for a single
 * request. The request is copied for it - the shared walk rewrites in place and
 * nothing is actually rewritten here - which is affordable exactly because
 * resolution happens once per run, over a plan already bounded by
 * `maxScenarioSteps`.
 *
 * **Both namespaces in one template**, for the reason `DataFieldTemplate`
 * records: a field carrying one of each is one string, and two templates over
 * it would each rebuild it from their own literals, so the second join would
 * undo the first.
 *
 * The body's **mode** is read here as well as its text: it is what decides
 * whether the body is a JSON or an XML document, and so how each of its tokens
 * binds. A template is therefore only valid for a request whose body mode is
 * the one it was split from.
 */
[[nodiscard]] StepDataTemplate tokenize_bindable_fields (const vayu::Request& request,
const vayu::http::BoundColumnNames& bound_columns = {});

/**
 * Join @p tmpl's fields against @p binding, in place on @p request.
 *
 * @p tmpl must have been built from a request of the same shape (in practice:
 * from the plan step @p request was copied from), because a field is addressed
 * by its position in the walk.
 *
 * The identity and generator halves cannot fail - both names always have a
 * value, and a generator always produces one - so every failure names a data
 * token or the template: a column the row does not carry,
 * a column whose cell is `null`, a `{{data.*}}` token in a run with no row at
 * all, a value that would end the header line it is bound into, two header
 * names that bound to one name, and a token placed where an `xml` body has no
 * encoding that would keep the document meaning what it says - inside a comment
 * or a processing instruction. That last one fails for every row alike, because
 * it is the template's fault rather than the row's, and is reported before the
 * row is even consulted.
 *
 * On failure @p request is left partially bound and must not be sent - the
 * caller ends the step. Repairing it would mean a second copy of the composed
 * request per step per iteration for a path that never reaches the wire.
 */
[[nodiscard]] DataBindResult apply_iteration_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const IterationBinding& binding);

/**
 * Split @p auth's credential strings around their `{{data.column}}` tokens and
 * their `{{$vu}}` / `{{$iteration}}` identity (issue #1055).
 *
 * **Both namespaces the bind can answer, and only those.** A `{{$guid}}` is not
 * one of them: composition generates a generator inside the auth block rather
 * than deferring it (issue #995), so none survives into a credential to be
 * split, and one kept here would defer a build for a token that is already a
 * value.
 *
 * The identity used to be excluded, because deferring a build was what let a
 * row reach a credential and a build was deferred only for a run that *had*
 * rows - so splitting it out would have bound `{{$vu}}` in a data-driven run
 * and sent it base64-encoded as written in every other, which is a rule nobody
 * could hold in their head. What changed is the deferral, not this: a build is
 * deferred for the credentials that carry a token rather than for the runs that
 * carry rows, so one rule now holds on every run shape.
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
[[nodiscard]] StepDataTemplate tokenize_auth_fields (const vayu::http::Auth& auth,
const vayu::http::BoundColumnNames& bound_columns = {});

/**
 * Join @p tmpl's credentials against @p binding, in place on @p auth.
 *
 * @p auth must be the parsed auth @p tmpl was split from, for the same reason
 * `apply_iteration_template` needs the request it was split from: a credential is
 * addressed by its position in the walk.
 *
 * The whole @ref IterationBinding rather than a row, and for the reason that
 * type exists: a credential carrying `{{data.user}}` beside `{{$vu}}` is joined
 * once, from both sources at once. A null row is not an error here - it is a run
 * with no set at all, which answers the identity and refuses a data token by
 * name (issue #1055).
 */
[[nodiscard]] DataBindResult apply_auth_data_template (vayu::http::Auth& auth,
const StepDataTemplate& tmpl,
const IterationBinding& binding);

/**
 * Bind @p auth's credentials against @p binding and apply the result to
 * @p request.
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
 * one, and an oauth2 config carrying a token this would defer for is refused
 * before any build is deferred (@ref first_oauth2_deferrable_token).
 */
[[nodiscard]] DataBindResult bind_auth_row (vayu::Request& request,
vayu::http::Auth auth,
const StepDataTemplate& tmpl,
const IterationBinding& binding);

/**
 * One iteration's whole bind, in the order that makes it correct: @p fields
 * into @p request - its row and its identity together - then @p credentials
 * into the auth applied on top of it.
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
 * was applied at build time passes its `NoAuth` and pays nothing. The
 * credentials are joined against the whole of @p binding - its row where the
 * run has one, and its identity, which every run has (issue #1055).
 *
 * On failure @p request is left partially bound and must not be sent - see
 * `apply_iteration_template`, whose rule this inherits.
 */
[[nodiscard]] DataBindResult bind_iteration (vayu::Request& request,
const StepDataTemplate& fields,
const vayu::http::Auth& auth,
const StepDataTemplate& credentials,
const IterationBinding& binding);

/**
 * The first token a deferred credential could bind - a `{{data.column}}` or a
 * `{{$vu}}` / `{{$iteration}}` identity - in any string of @p value,
 * recursively, written back with its braces, or `nullopt` when it carries none.
 *
 * The same namespaces `tokenize_auth_fields` splits for, because this is the
 * refusal that stands where that split cannot be honoured: a block deferral
 * does not reach must refuse every token deferral would otherwise have bound,
 * or the two disagree about which tokens mean anything (issue #1055).
 *
 * @p bound_columns extends the scan to the bare spelling (issue #1007), for the
 * same reason the bind reads it: a run's column reaching a block that cannot
 * defer is the failure this scan exists to name, and which way the token was
 * written does not change that.
 *
 * For a block that has no bind to offer at all and must therefore refuse rather
 * than defer: an OAuth 2.0 config, whose token is acquired once when the plan
 * is resolved. Object *keys* are not scanned - a column name where a config key
 * belongs is not a placement anyone means.
 */
[[nodiscard]] std::optional<std::string> first_deferrable_token_in (const nlohmann::json& value,
const vayu::http::BoundColumnNames& bound_columns = {});

/**
 * The first `{{data.column}}` or `{{$vu}}` / `{{$iteration}}` in @p auth's
 * OAuth 2.0 configuration, or `nullopt` - for any other mode as well as for an
 * oauth2 config carrying none.
 *
 * **OAuth 2.0 is the one mode deferral cannot serve**, and this is the check
 * that says so, for both callers that defer. Its token is acquired against the
 * token endpoint once - when a plan is resolved, or before a single send leaves
 * - so there is no later moment at which a row could reach the acquisition, the
 * way binding a credential before `apply_auth` encodes it reaches every other
 * mode. The identity is refused for the same reason and not a weaker one: it is
 * known per iteration, and the acquisition happens before any iteration exists
 * (issue #1055). Refused by name rather than sent to the token endpoint as the
 * literal token text.
 *
 * Every other mode's credentials are walked by `walk_auth_credentials` and
 * bound; an oauth2 config is deliberately absent from that walk, which is why
 * it needs this second, config-shaped scan.
 */
[[nodiscard]] std::optional<std::string> first_oauth2_deferrable_token (
const vayu::http::Auth& auth,
const vayu::http::BoundColumnNames& bound_columns = {});

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
 * `apply_iteration_template`, which is the whole point of splitting once.
 */
[[nodiscard]] DataBindResult
bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index);

} // namespace vayu::core

#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file elements.hpp
 * @brief The element registry (issue #1513) and the pipeline that runs a
 *        compiled element at a phase of a step (issue #1514): the kind a
 *        behaviour attached to a request or collection at a phase of a step
 *        is, never a column (issue #1512).
 *
 * A kind is one translation unit under `engine/src/core/elements/`, whose
 * `make_*_kind()` names it, its config schema and (once a kind runs one) its
 * behaviour; `Registry::instance()` holds the fixed, explicit list of them
 * (`engine/src/core/elements/registry.cpp`), the one place a kind name maps to
 * code (the extensibility contract's rule 1 in issue #1512). A namespace-scope
 * self-registering static initialiser - the issue's own wording - is declined:
 * `engine/CLAUDE.md` requires nothing at namespace scope be built at run time,
 * because a throwing initialiser before `main` has no frame to catch it and no
 * defined order against another translation unit's. An explicit call list
 * inside `Registry::instance()`'s function-local static keeps the same "one
 * new file, one new line" cost the issue asks for, on the same "explicit list,
 * never a glob" precedent `engine/tests/CMakeLists.txt` already uses.
 */

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::core {

/**
 * Everything a compiled element's `apply` reads and writes (issue #1514).
 *
 * Deliberately decoupled from `vayu::runtime::ScriptEngine` and from
 * `vayu::http::routes::ScriptVariableScopes`: those live one layer up (in
 * `vayu_core`'s http-adjacent code, which itself depends on `core/elements`),
 * so a script kind reaches them through callbacks its caller binds rather than
 * through a type this header would have to include and create a cycle with. A
 * declarative kind (`extract.*`, `assert.*`, `timer.think`) touches none of
 * the script fields at all.
 */
struct ElementContext {
    /// Mutable, before send in `step.before` and unchanged (already sent) in
    /// `step.after` - a kind that reads it in `step.after` is reading what
    /// went out, not what could still change.
    vayu::Request& request;
    /// Null in `step.before`; set once the send has answered.
    vayu::Response* response = nullptr;

    /// Runs @p script as this step's pre-request script, exactly as
    /// `execute_exchange` always has, and returns its result. Unset only in a
    /// context with no script slot at all (there is none today - both callers
    /// always bind this).
    std::function<vayu::ScriptResult (const std::string& script)> run_pre_script;
    std::function<vayu::ScriptResult (const std::string& script)> run_post_script;
    /// Where `script.pre` / `script.post` write the result of the callbacks
    /// above, so the caller's `ExchangeOutcome`-shaped result carries it under
    /// the same two fields it always has - nothing the response view or the
    /// step trace's `scripts` node reads changes shape.
    vayu::ScriptResult& pre_script_result;
    vayu::ScriptResult& post_script_result;

    /// `extract.*`'s write, addressed by the schema's `scope` value
    /// (`"env"` | `"collection"` | `"globals"`) and variable name. The
    /// callback is the caller's: it knows which `ScriptVariableScopes` a
    /// design send or a sequential step's iteration is writing into.
    std::function<void (std::string_view scope, const std::string& name, const std::string& value)> set_variable;

    /// Polled by `timer.think`'s wait; returns true to abort it early (a
    /// design send has none - a single exchange has nothing to stop mid-wait -
    /// so only the sequential run's plan walk binds this).
    std::function<bool ()> should_stop;

    /// One JSON parse of the response body, shared by every `extract.*` /
    /// `assert.jsonpath` on the same step rather than paid per kind.
    /// `body_parse_attempted` distinguishes "not tried yet" from "tried and
    /// the body was not JSON" so a second kind does not retry a parse that
    /// already failed.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<nlohmann::json> parsed_body{};
    bool body_parse_attempted = false;
    /// `maxElementBodyBytes` - a response past this is not parsed, and every
    /// JSON-reading kind on the step reports `skipped` rather than paying for
    /// (or failing on) a parse of an oversized body.
    size_t max_body_bytes = size_t{ 1024 } * 1024;

    /// Filled by `Element::apply`, reset by `ElementPipeline::run` before each
    /// call and read back into the pushed `ElementOutcome` afterwards - the
    /// same "write through a bound reference, no return-shape per kind" split
    /// `ElementKind::compile` and `Element::apply` already use. The `{}` on
    /// each (not just a bare declaration) is load-bearing, on the
    /// `Variable::created_at` precedent: a designated-initializer call site
    /// that stops short of these trailing fields is otherwise a
    /// -Wmissing-field-initializers warning at every one of them.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::string outcome_status{}; ///< "ok" | "failed" | "missing" | "skipped" | "error"
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<std::string> outcome_message{};
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<int64_t> outcome_waited_ms{};
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<bool> outcome_wrote{};
};

/**
 * The seven points of a step an element can run at (issue #1512's Model
 * section). Derived from a kind's registration, never stored on the element
 * instance itself.
 */
enum class Phase : std::uint8_t {
    RunStart,
    IterationStart,
    StepBefore,
    StepAfter,
    StepBetween,
    IterationEnd,
    RunEnd,
};

/**
 * Whether a compiled element is cheap enough to run inline on the load hot
 * path, or costly enough (a `script.*` kind) that the load paths defer it to
 * the replay by default (#1495). Phase 0 declares the split; nothing reads it
 * yet - no kind executes before #1514.
 */
enum class HotPathClass : std::uint8_t {
    Declarative,
    Script,
};

/** A compiled, runnable behaviour. No kind overrides `apply` before #1514. */
class Element {
    public:
    virtual ~Element ()                 = default;
    Element ()                          = default;
    Element (const Element&)            = delete;
    Element& operator= (const Element&) = delete;
    Element (Element&&)                 = delete;
    Element& operator= (Element&&)      = delete;

    [[nodiscard]] virtual Phase phase () const = 0;
    virtual void apply (ElementContext& ctx)   = 0;
};

/**
 * What the registry knows about one kind, independent of any element instance
 * - the catalogue `GET /elements/kinds` serves is this struct, one per
 * registered kind.
 */
struct ElementKind {
    std::string kind; // e.g. "assert.status"; validated, never displayed alone.
    int version = 1;
    std::vector<Phase> phases;
    nlohmann::json config_schema; // A JSON Schema `config` must validate against.
    std::string label;
    std::string description;
    std::string category;
    HotPathClass hot_path = HotPathClass::Declarative;
    // Absent for a kind that only validates (phase 0's `inherit.disable`);
    // present once a kind actually runs (#1514 onward).
    std::function<std::unique_ptr<Element> (const nlohmann::json& config)> compile;
};

/**
 * The one place a kind name maps to code (issue #1512's extensibility
 * contract, rule 1). A process-wide singleton behind a function-local static,
 * safe under the engine's worker-thread-per-connection model and free of the
 * static-initialisation-order problem a namespace-scope registry object would
 * have.
 */
class Registry {
    public:
    static Registry& instance ();

    /** Test-only: adds a kind beyond the fixed built-in list, e.g. `test.echo`. */
    void register_kind_for_test (ElementKind kind);

    [[nodiscard]] const ElementKind* find (const std::string& kind) const;
    [[nodiscard]] const std::vector<ElementKind>& kinds () const;

    /**
     * Validates the wire shape of an `elements` field: an array of objects,
     * each a known kind, each `config` against that kind's schema, with no
     * duplicate `id`. Returns the first violation's message, or `nullopt` if
     * the whole array is well-formed - the same "pure validator, route
     * converts to a 400" split `core::validate_thresholds` uses.
     */
    [[nodiscard]] std::optional<std::string> validate (const nlohmann::json& elements) const;

    Registry (const Registry&)            = delete;
    Registry& operator= (const Registry&) = delete;
    Registry (Registry&&)                 = delete;
    Registry& operator= (Registry&&)      = delete;

    private:
    Registry ()  = default;
    ~Registry () = default;

    void register_kind (ElementKind kind);

    std::vector<ElementKind> kinds_;
};

/** `GET /elements/kinds`' body: every registered kind, catalogue-shaped. */
[[nodiscard]] nlohmann::json elements_catalogue ();

/**
 * One compiled element's outcome, in the shape the step trace's `elements`
 * array and the `test.echo`-proved contract both serve (issue #1514).
 */
struct ElementOutcome {
    std::string id;
    std::string kind;
    nlohmann::json origin;
    std::string status; ///< "ok" | "failed" | "missing" | "skipped" | "error"
    std::optional<std::string> message;
    std::optional<int64_t> waited_ms;
    std::optional<bool> wrote;

    [[nodiscard]] nlohmann::json to_json () const;
};

/**
 * One entry of a resolved `elements` array, compiled once (issue #1512's
 * "Pipeline" section - "compiled once per plan step").
 *
 * `config` is kept verbatim beside the compiled `element` (rather than only
 * inside the closure `compile` built) so a caller that needs the raw
 * configuration - the load path's deferred script replay reading a
 * `script.post` entry's `config.script` text (`run_manager.cpp`) - does not
 * have to invoke the element to get it.
 */
struct CompiledElement {
    std::string id;
    std::string kind;
    nlohmann::json origin;
    nlohmann::json config;
    bool enabled = true;
    /// Null for a kind with no `compile` (`inherit.disable` never reaches
    /// here - `compose_elements` already consumes it - but a kind the
    /// registry cannot find, which validation should already have refused,
    /// compiles to nothing rather than aborting the whole step).
    std::unique_ptr<Element> element;
};

/**
 * Compile a resolved `elements` array (as `request_composer.cpp`'s
 * `compose_elements` produces it - each entry stamped with `origin`) into the
 * ordered list `ElementPipeline::run` iterates.
 *
 * One entry in, one `CompiledElement` out, in the same order. A kind with no
 * runnable behaviour - unknown to this registry (the DB held a row a newer
 * engine wrote), or validate-only like `test.echo` - compiles to a null
 * `element`; with no phase to dispatch it at, `ElementPipeline::run` never
 * calls it and never reports an outcome for it, the same as a kind this build
 * has simply never heard of.
 */
[[nodiscard]] std::vector<CompiledElement> compile_elements (const nlohmann::json& elements);

/**
 * The response body parsed as JSON, cached on @p ctx so `extract.json`,
 * `extract.regex`'s field="body" and `assert.jsonpath` on the same step share
 * one parse. Returns null when there is no response yet, the body is over
 * `ElementContext::max_body_bytes`, or it does not parse as JSON - a caller
 * that needs to tell those apart reads `ctx.body_parse_attempted` (true after
 * this returns) against whether a response is set.
 */
[[nodiscard]] const nlohmann::json* ensure_parsed_body (ElementContext& ctx);

/**
 * Runs every compiled element of @p elements whose kind's phase is @p phase,
 * in list order, appending one outcome to @p sink per element - including a
 * disabled one, reported `"skipped"` without calling `apply` (issue #1512's
 * extensibility contract, rule 1: the pipeline is the only thing that decides
 * whether a kind runs, never a caller re-implementing the phase filter).
 *
 * An exception `apply` lets escape is caught here and reported as this one
 * element's `"error"` outcome with the exception's `what()` as the message -
 * a kind that throws must not abort the rest of the step.
 */
class ElementPipeline {
    public:
    static void run (Phase phase,
    ElementContext& ctx,
    const std::vector<CompiledElement>& elements,
    std::vector<ElementOutcome>& sink);
};

} // namespace vayu::core

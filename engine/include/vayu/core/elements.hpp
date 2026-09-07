#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file elements.hpp
 * @brief The element registry (issue #1513): the kind a behaviour attached to
 *        a request or collection at a phase of a step is, never a column
 *        (issue #1512).
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
 *
 * Phase 0 registers no behaviour kind - `ElementContext` is #1514's pipeline
 * type, forward-declared here only so `Element::apply` has a signature to
 * declare. It registers `inherit.disable` (validated, no `apply`) here, and
 * `test.echo` in the test binary only (`engine/tests/elements_registry_test.cpp`).
 */

#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

/** Defined by the pipeline (#1514); no phase-0 kind constructs or reads one. */
struct ElementContext;

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

} // namespace vayu::core

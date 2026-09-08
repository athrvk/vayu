#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/jmeter_import.hpp
 * @brief A JMeter `.jmx` test plan as an import (issue #1518) - the format
 *        every other engine-side importer's own doc names as still missing.
 *
 * A `.jmx` file is JMeter's own serialization of its test-plan tree: a
 * `<jmeterTestPlan>` root holding one `<hashTree>`, whose children alternate
 * a test element (`<ThreadGroup>`, `<HTTPSamplerProxy>`, ...) with that
 * element's own `<hashTree>` of children - XML, never JSON or YAML, so this
 * is a second reader beside `core::read_document` (issue #853's "one YAML
 * reader"), through pugixml rather than a hand-rolled walk: the dialect is
 * fixed and small, but attribute/text access, entity decoding and malformed
 * input all belong to a real parser rather than a second, partial one.
 *
 * The mapping (JMeter class -> Vayu element kind) is `docs/engine/elements.md`
 * read backwards: `HTTPSamplerProxy` becomes a request, `ThreadGroup` and
 * `TestPlan` flatten into the collection (Vayu has no thread-group concept -
 * a collection already runs every request once), and everything else JMeter
 * calls a "config element" - extractors, assertions, timers, controllers,
 * pre/post-processors - becomes the matching element kind, attached to
 * whichever request or folder its own `<hashTree>` scopes it under. A class
 * this parser has no mapping for is counted by its own XML tag name in
 * `meta.skipped`, the same "nothing dropped quietly" rule every other
 * importer here follows (issue #1443) - so an unmapped `WhileController` or
 * `CookieManager` costs nothing to add support for later and is never a
 * silent loss today.
 *
 * Every element this parser builds is validated against the live element
 * registry before it is offered (`vayu::core::Registry::validate`) - a
 * config this parser mistranslates is dropped and counted rather than
 * reaching `POST /import/apply`, whose write is atomic across the whole
 * tree and would otherwise fail every other item in the same document for
 * one bad translation.
 */

#include "vayu/core/import_document.hpp"
#include "vayu/core/openapi_document.hpp"

#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <string_view>

namespace vayu::core {

/**
 * True when @p text looks like a JMeter `.jmx` test plan.
 *
 * Checked before the engine's one JSON/YAML reader ever sees the bytes - a
 * `.jmx` file is XML and would only fail both of those parses, the same way
 * an actually-unrecognised document does, which would misreport a `.jmx`
 * upload as "Unrecognised format" rather than routing it here. Bounded to a
 * short prefix of @p text: the tag is always near the top of a real file, and
 * scanning a large upload byte-for-byte to answer a yes/no this cheap serves
 * no caller.
 */
[[nodiscard]] bool is_jmeter_document (std::string_view text);

/**
 * A `.jmx` document pugixml could not parse as XML at all, or one with no
 * `<jmeterTestPlan>` root despite `is_jmeter_document` claiming it - the
 * `MalformedImport` of this parser, kept as its own type because that one's
 * message is hardcoded to "Malformed Insomnia export" and reused verbatim by
 * every one of its own call sites.
 */
class MalformedJmeter : public std::runtime_error {
    public:
    explicit MalformedJmeter (const std::string& detail)
    : std::runtime_error ("Malformed JMeter test plan: " + detail) {
    }
};

/**
 * @brief Parses @p text (already known to be a `.jmx` document) into the same
 *        `{collections, environments, globals, meta}` shape every other
 *        importer builds (issue #877's `ImportResult`).
 *
 * `environments` and `globals` are always empty - a `.jmx` file has neither
 * concept - and `meta.exampleCount` is always 0: JMeter records no saved
 * response the way a Postman or OpenAPI example is one.
 */
[[nodiscard]] nlohmann::ordered_json
parse_jmeter (const std::string& text, const ImportOptions& options, ImportTally& tally);

} // namespace vayu::core

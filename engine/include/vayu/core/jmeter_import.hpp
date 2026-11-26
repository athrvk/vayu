#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @brief A JMeter `.jmx` test plan as an import (#1518).
 *
 * A `.jmx` file is JMeter's serialization of its test-plan tree: a
 * `<jmeterTestPlan>` root holding one `<hashTree>`, whose children alternate a
 * test element (`<ThreadGroup>`, `<HTTPSamplerProxy>`, ...) with that element's
 * own `<hashTree>` of children. It is XML, never JSON or YAML, so this is a
 * second reader beside `core::read_document` (#853's "one YAML reader"),
 * through pugixml rather than a hand-rolled walk: the dialect is fixed and
 * small, but attribute/text access, entity decoding and malformed input belong
 * to a real parser, not a second, partial one.
 *
 * The mapping (JMeter class -> Vayu element kind) is `docs/engine/elements.md`
 * read backwards: `HTTPSamplerProxy` becomes a request; `ThreadGroup` and
 * `TestPlan` flatten into the collection (Vayu has no thread-group concept - a
 * collection already runs every request once; a group's threads, ramp-up,
 * duration and loops are counted as `ThreadGroup_profile`); everything else
 * JMeter calls a "config element" - extractors, assertions, timers,
 * controllers, pre/post-processors - becomes the matching element kind,
 * attached to whichever request or folder its own `<hashTree>` scopes it under.
 * A class with no mapping is counted by its XML tag name in `meta.skipped`, the
 * "nothing dropped quietly" rule every importer here follows (#1443), so an
 * unmapped `WhileController` or `CookieManager` is never a silent loss.
 *
 * Every element built is validated against the live element registry
 * (`vayu::core::Registry::validate`) before it is offered: a mistranslated
 * config is dropped and counted rather than reaching `POST /import/apply`,
 * whose write is atomic across the whole tree and would fail every other item
 * in the document for one bad translation.
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
 * Checked before the engine's one JSON/YAML reader sees the bytes: a `.jmx`
 * file is XML and would fail both parses, like a truly unrecognised document,
 * and be misreported as "Unrecognised format" instead of routed here. Only a
 * short prefix of @p text is scanned: the tag is always near the top of a real
 * file, and a byte-for-byte scan of a large upload serves no caller.
 */
[[nodiscard]] bool is_jmeter_document (std::string_view text);

/**
 * A `.jmx` document pugixml could not parse as XML at all, or one with no
 * `<jmeterTestPlan>` root despite `is_jmeter_document` claiming it: this
 * parser's `MalformedImport`, a type of its own because that one's message is
 * hardcoded to "Malformed Insomnia export" at every call site.
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
 *        importer builds (#877's `ImportResult`).
 *
 * `environments` and `globals` are always empty - a `.jmx` file has neither
 * concept - and `meta.exampleCount` is always 0: JMeter records no saved
 * response the way a Postman or OpenAPI example is one.
 */
[[nodiscard]] nlohmann::ordered_json
parse_jmeter (const std::string& text, const ImportOptions& options, ImportTally& tally);

} // namespace vayu::core

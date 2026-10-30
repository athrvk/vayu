#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file element_defaults.hpp
 * @brief What an element's config means when a key is absent (issue #3045).
 *
 * Each constant is read by the kind's code (`config.value (key, DEFAULT)`)
 * *and* written into the kind's `configSchema` as the property's `default`,
 * which `GET /elements/kinds` serves. A reader and a schema that spelt the
 * literal separately could drift; one named constant cannot. The values the
 * schema's `default` carries are therefore the values the engine runs.
 *
 * Only a property with a default of its own is listed: a `required` property,
 * and one whose absence is a state in its own right (`assert.jsonpath`'s
 * `exists`, `control.throughput`'s `percent` / `everyN`), has none.
 */

namespace vayu::core::element_defaults {

/// `assert.size` `op`: the comparison used when none is named.
constexpr const char* ASSERT_SIZE_OP = "lte";

/// `assert.contains` `mode`.
constexpr const char* ASSERT_CONTAINS_MODE = "contains";

/// `assert.contains` / `extract.regex` `field`: which part of the response.
constexpr const char* RESPONSE_FIELD = "body";

/// `extract.*` `scope`: the variable scope an extractor writes into.
constexpr const char* EXTRACT_SCOPE = "collection";

/// `extract.*` `required`.
constexpr bool EXTRACT_REQUIRED = false;

/// `assert.jsonpath` / `assert.contains` `negate`.
constexpr bool ASSERT_NEGATE = false;

/// `timer.pacing` `perUser`, and the plan scan that sizes its shared clocks.
constexpr bool TIMER_PACING_PER_USER = true;

/// `timer.throughput` `perUser`: shared across virtual users by default, the
/// opposite of `timer.pacing`.
constexpr bool TIMER_THROUGHPUT_PER_USER = false;

/// `control.throughput` `perUser`, and the scan that slots its shared counters.
constexpr bool CONTROL_THROUGHPUT_PER_USER = true;

/// `control.transaction` `includeTimers`: a between-member timer wait stays
/// out of the transaction's summed time unless asked for.
constexpr bool CONTROL_TRANSACTION_INCLUDE_TIMERS = false;

/// `script.pre` / `script.post` `inline`.
constexpr bool SCRIPT_INLINE = false;

} // namespace vayu::core::element_defaults

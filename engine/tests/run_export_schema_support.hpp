#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/run_export_schema_support.hpp
 * @brief `docs/engine/run-export.schema.json` loaded and applied, for the two
 *        suites that hold a run-report document to it (#2127, #2131).
 */

#include <nlohmann/json.hpp>
#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validator.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace vayu::tests {

inline nlohmann::json load_run_export_schema () {
    const std::filesystem::path path = std::filesystem::path (VAYU_ENGINE_SOURCE_DIR) /
    ".." / "docs" / "engine" / "run-export.schema.json";
    std::ifstream in (path);
    // A schema that failed to open parses "" as invalid JSON, which fails the
    // first test loudly rather than passing every case for want of a schema.
    std::stringstream buffer;
    buffer << in.rdbuf ();
    return nlohmann::json::parse (buffer.str ());
}

/// The validator's complaints about @p document, empty when it validates.
inline std::string run_export_schema_errors (const nlohmann::json& schema_json,
const nlohmann::json& document) {
    valijson::Schema schema;
    valijson::SchemaParser parser;
    const valijson::adapters::NlohmannJsonAdapter schema_adapter (schema_json);
    parser.populateSchema (schema_adapter, schema);

    valijson::Validator validator;
    const valijson::adapters::NlohmannJsonAdapter target (document);
    valijson::ValidationResults results;
    if (validator.validate (schema, target, &results)) {
        return {};
    }
    std::string errors;
    valijson::ValidationResults::Error error;
    while (results.popError (error)) {
        std::string context;
        for (const std::string& step : error.context) {
            context += step;
        }
        errors += context + ": " + error.description + "\n";
    }
    return errors;
}

} // namespace vayu::tests

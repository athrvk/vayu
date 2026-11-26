#pragma once

/**
 * @file scenario_plan_fixture.hpp
 * @brief The `ScenarioPlanTest` fixture, shared by every `scenario_plan*_test.cpp`.
 *
 * The suite is split by subject across those files and keeps one name, so
 * `--gtest_filter=ScenarioPlanTest.*` and the scratch-database RESOURCE_LOCK list see it
 * whole. The class is defined here, once, outside an anonymous namespace, so each
 * translation unit sees the same type; gtest refuses a suite whose `TEST_F`s name
 * different fixture classes, which an anonymous namespace per file would be.
 */

#include <gtest/gtest.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"

namespace vayu::tests::scenario_plan {

using nlohmann::json;

class ScenarioPlanTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_scenario_plan.db";

    void SetUp () override {
        reset_database ();
    }
    /// A fresh database on one path. The old handle is closed *before* the
    /// files are removed and the new one opens, so a test that needs a clean
    /// tree mid-run (the fixture loop, whose cases repeat ids) cannot end up
    /// with two connections to a file one of them has already deleted.
    void reset_database () {
        db_.reset ();
        cleanup ();
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        cleanup ();
    }
    static void cleanup () {
        vayu::tests::remove_database_files (DB_PATH);
    }

    // `created_at` is the second sort key, so only a test about a tie needs to
    // state it; everything else shares one timestamp and sorts on `order`.
    void seed_collection (const std::string& id,
    const std::string& parent_id,
    int order                      = 0,
    const std::string& auth        = "",
    const std::string& pre_script  = "",
    int64_t created_at             = 1,
    const std::string& data_schema = "{}") {
        vayu::db::Collection col;
        col.id = id;
        if (!parent_id.empty ()) {
            col.parent_id = parent_id;
        }
        col.name = "Collection " + id;
        col.auth = auth;
        if (!pre_script.empty ()) {
            col.elements = nlohmann::json::array (
            { nlohmann::json{ { "id", "el_pre_" + id }, { "kind", "script.pre" },
            { "enabled", true }, { "config", { { "script", pre_script } } } } })
                           .dump ();
        }
        col.data_schema = data_schema;
        col.order       = order;
        col.created_at  = created_at;
        col.updated_at  = created_at;
        db_->create_collection (col);
    }

    void seed_request (const std::string& id,
    const std::string& collection_id,
    int order                      = 0,
    const std::string& url         = "https://example.test/{{path}}",
    const std::string& auth        = "",
    const std::string& post_script = "",
    int64_t created_at             = 1,
    const std::string& headers     = "",
    const std::string& body        = "") {
        vayu::db::Request r;
        r.id            = id;
        r.collection_id = collection_id;
        r.name          = "Request " + id;
        r.method        = vayu::HttpMethod::GET;
        r.url           = url;
        r.headers       = headers;
        r.body          = body;
        r.auth          = auth;
        if (!post_script.empty ()) {
            r.elements = nlohmann::json::array (
            { nlohmann::json{ { "id", "el_post_" + id }, { "kind", "script.post" },
            { "enabled", true }, { "config", { { "script", post_script } } } } })
                         .dump ();
        }
        r.order      = order;
        r.created_at = created_at;
        r.updated_at = created_at;
        db_->save_request (r);
    }

    /// Replace the stored `elements` of request @p id.
    void set_request_elements (const std::string& id, const json& elements) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row) << id;
        row->elements = elements.dump ();
        db_->save_request (*row);
    }

    /// Replace the stored `elements` of collection @p id.
    void set_collection_elements (const std::string& id, const json& elements) {
        auto row = db_->get_collection (id);
        ASSERT_HAS_VALUE (row) << id;
        row->elements = elements.dump ();
        db_->create_collection (*row); // a replace, keyed on the id
    }

    /// Store request @p id with `stream` set, as the request editor saves it.
    void mark_streaming (const std::string& id) {
        auto row = db_->get_request (id);
        ASSERT_HAS_VALUE (row) << id;
        row->stream = true;
        db_->save_request (*row);
    }

    /// Write a config value through the catalogue, as POST /config does.
    void set_config (const char* key, const std::string& value) {
        auto entry = db_->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = value;
        db_->save_config_entry (*entry);
    }

    void seed_environment (const std::string& id, const std::string& variables) {
        vayu::db::Environment env;
        env.id         = id;
        env.name       = "Env " + id;
        env.variables  = variables;
        env.created_at = 1;
        env.updated_at = 1;
        db_->save_environment (env);
    }

    // Generous bounds unless a test is about a bound.
    static vayu::core::ScenarioResolveOptions options (size_t max_steps = 200,
    size_t max_data_rows                                                = 1000,
    size_t max_data_bytes = vayu::core::constants::scenario::MAX_DATA_BYTES) {
        vayu::core::ScenarioResolveOptions opts;
        opts.timeout_ms            = 30000;
        opts.limits.max_steps      = max_steps;
        opts.limits.max_data_rows  = max_data_rows;
        opts.limits.max_data_bytes = max_data_bytes;
        return opts;
    }

    static json block (const std::string& collection_id, bool recursive = false) {
        return json{ { "source", "collection" },
            { "collectionId", collection_id }, { "recursive", recursive } };
    }

    std::vector<std::string> step_ids (const vayu::core::ScenarioPlan& plan) {
        std::vector<std::string> ids;
        ids.reserve (plan.steps.size ());
        for (const auto& step : plan.steps) {
            ids.push_back (step.request_id);
        }
        return ids;
    }

    std::unique_ptr<vayu::db::Database> db_;
};

} // namespace vayu::tests::scenario_plan

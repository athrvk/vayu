#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/spec_move_fixture.hpp
 * @brief Two spec-bound trees and an unbound collection, for the move paths
 *        that take a stamped request out of its binding (#3446).
 *
 * `POST /reorder`, `PUT /requests/:id` and `PUT /collections/:id` (#3470) all
 * answer the same question, so their suites build the same ground through the
 * real route cores and ask the source binding the same three things
 * afterwards: what the diff of its
 * unchanged document adds, what it lists as declined, and what a safe sync
 * of a revision that changes nothing but `info.version` creates.
 */

#include <cstddef>
#include <string>
#include <utility>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>

#include "vayu/db/database.hpp"

namespace vayu::http::routes {
// Defined in specs.cpp / collections.cpp / requests.cpp / spec_diff.cpp /
// spec_sync.cpp; each returns {http_status, json_body}.
std::pair<int, nlohmann::json>
create_spec_document_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_collection_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
diff_spec_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
spec_sync_response (vayu::db::Database& db, const nlohmann::json& body);
} // namespace vayu::http::routes

namespace vayu::tests {

/**
 * The `id` a create core answered with, or `""` when it answered none.
 *
 * `find` rather than `value ("id", std::string{})`: a release GCC 13 inlines
 * that accessor far enough to report a `-Wnull-dereference` inside nlohmann,
 * fatal under CI's `-Werror` (the shape `default_headers_test.cpp`'s
 * `row_source` avoids the same way).
 */
inline std::string id_of (const nlohmann::json& response) {
    const auto id = response.find ("id");
    return id != response.end () && id->is_string () ? id->get<std::string> () :
                                                       std::string{};
}

/// Declares `listPets` and `listOwners`.
constexpr const char* PETS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}}},)"
R"("/owners":{"get":{"operationId":"listOwners","responses":{"200":{}}}}}})";

/// `PETS_DOC` with only `info.version` moved: a sync of it is a real sync that
/// has no operation to add.
constexpr const char* PETS_DOC_REVISED =
R"({"openapi":"3.1.0","info":{"title":"Pets","version":"1.1.0"},)"
R"("paths":{"/pets":{"get":{"operationId":"listPets","responses":{"200":{}}}},)"
R"("/owners":{"get":{"operationId":"listOwners","responses":{"200":{}}}}}})";

/// Declares `listCars` and nothing `PETS_DOC` does.
constexpr const char* CARS_DOC =
R"({"openapi":"3.1.0","info":{"title":"Cars","version":"1.0.0"},)"
R"("paths":{"/cars":{"get":{"operationId":"listCars","responses":{"200":{}}}}}})";

/**
 * `pets` binds `PETS_DOC` and holds `listPets`; its unbound tag folder `owners`
 * holds `listOwners`, so every operation of the document has its request.
 * `cars` binds `CARS_DOC` and holds `listCars`; `plain` binds nothing.
 */
class SpecMoveTrees {
    public:
    explicit SpecMoveTrees (vayu::db::Database& db) : db_ (db) {
        pets_spec = store_spec (PETS_DOC);
        pets      = create_bound ("Pets", pets_spec);
        owners    = create_collection (
        nlohmann::json{ { "name", "owners" }, { "parentId", pets } });
        cars  = create_collection (nlohmann::json{ { "name", "Cars" },
        { "openapi", { { "specId", store_spec (CARS_DOC) } } } });
        plain = create_collection (nlohmann::json{ { "name", "Scratch" } });

        list_pets   = create_stamped (pets, "GET", "/pets", "listPets");
        list_owners = create_stamped (owners, "GET", "/owners", "listOwners");
        list_cars   = create_stamped (cars, "GET", "/cars", "listCars");
    }

    /**
     * A collection bound to @p spec_id, at the root or under @p parent_id: a
     * second binding of the same document, which is or is not inside `pets`'s
     * contract depending on where it sits.
     */
    std::string create_bound (const std::string& name,
    const std::string& spec_id,
    const std::string& parent_id = {}) {
        nlohmann::json body{ { "name", name }, { "openapi", { { "specId", spec_id } } } };
        if (!parent_id.empty ()) {
            body["parentId"] = parent_id;
        }
        return create_collection (body);
    }

    /** A request under @p collection_id stamped with the named operation. */
    std::string create_stamped (const std::string& collection_id,
    const std::string& method,
    const std::string& path,
    const std::string& operation_id) {
        auto [status, response] = vayu::http::routes::create_request_response (db_,
        nlohmann::json{ { "collectionId", collection_id }, { "name", operation_id },
        { "method", method }, { "url", "https://example.test" + path },
        { "specOperation",
        { { "operationId", operation_id }, { "method", method }, { "path", path } } } });
        EXPECT_EQ (status, 200) << response.dump ();
        return id_of (response);
    }

    /** `POST /specs/diff` of @p collection_id against @p content. */
    nlohmann::json diff (const std::string& collection_id, const char* content) {
        auto [status, response] = vayu::http::routes::diff_spec_response (db_,
        nlohmann::json{ { "collectionId", collection_id },
        { "spec", { { "content", content } } } });
        EXPECT_EQ (status, 200) << response.dump ();
        return response;
    }

    /// The diff of `pets` against the document it is bound to.
    nlohmann::json diff_pets () {
        return diff (pets, PETS_DOC);
    }

    /// How many requests a safe sync of `PETS_DOC_REVISED` onto `pets` creates.
    size_t safe_sync_pets_created () {
        auto [status, response] = vayu::http::routes::spec_sync_response (db_,
        nlohmann::json{ { "collectionId", pets },
        { "spec", { { "content", PETS_DOC_REVISED } } }, { "policy", "safe" } });
        EXPECT_EQ (status, 200) << response.dump ();
        const auto created = response.find ("created");
        return created != response.end () && created->is_number_unsigned () ?
        created->get<size_t> () :
        0;
    }

    std::string pets_spec;
    std::string pets;
    std::string owners;
    std::string cars;
    std::string plain;
    std::string list_pets;
    std::string list_owners;
    std::string list_cars;

    private:
    std::string store_spec (const char* content) {
        auto [status, response] = vayu::http::routes::create_spec_document_response (
        db_, nlohmann::json{ { "content", content } });
        EXPECT_EQ (status, 200) << response.dump ();
        return id_of (response);
    }

    std::string create_collection (const nlohmann::json& body) {
        auto [status, response] =
        vayu::http::routes::create_collection_response (db_, body);
        EXPECT_EQ (status, 200) << response.dump ();
        return id_of (response);
    }

    vayu::db::Database& db_;
};

} // namespace vayu::tests

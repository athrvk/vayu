/**
 * @file http/routes/environments.cpp
 * @brief Environment management routes
 */

#include "vayu/http/routes.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

void register_environment_routes(RouteContext& ctx) {
    /**
     * GET /environments
     * Retrieves all saved environments from the database.
     * Environments contain variables that can be used in requests (e.g., API keys, base URLs).
     * Returns: Array of environment objects with id, name, variables, and timestamps.
     */
    ctx.server.Get("/environments", [&ctx](const httplib::Request&, httplib::Response& res) {
        auto envs = ctx.db.get_environments();
        nlohmann::json response = nlohmann::json::array();
        for (const auto& e : envs) {
            response.push_back(vayu::json::serialize(e));
        }
        res.set_content(response.dump(), "application/json");
    });

    /**
     * POST /environments
     * Creates or updates an environment in the database.
     * If 'id' is provided and exists, performs a partial update.
     * Otherwise, creates a new environment (requires 'name').
     * Body params: id (optional string), name (string), variables (optional object)
     * Returns: The saved environment object.
     */
    ctx.server.Post("/environments", [&ctx](const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse(req.body);

            std::string id;
            if (json.contains("id") && !json["id"].is_null()) {
                id = json["id"].get<std::string>();
            } else {
                id = "env_" + std::to_string(now_ms());
            }

            vayu::db::Environment e;
            auto existing = ctx.db.get_environment(id);

            if (existing) {
                e = *existing;
            } else {
                if (!json.contains("name") || json["name"].is_null()) {
                    send_error(res, 400, "Missing required field: name");
                    return;
                }
                e.id = id;
            }

            if (json.contains("name") && !json["name"].is_null()) {
                e.name = json["name"].get<std::string>();
            }
            if (json.contains("variables")) {
                e.variables = json["variables"].dump();
            }

            e.updated_at = now_ms();

            ctx.db.save_environment(e);
            res.set_content(vayu::json::serialize(e).dump(), "application/json");
        } catch (const std::exception& e) {
            send_error(res, 400, e.what());
        }
    });
}

}  // namespace vayu::http::routes

/**
 * @file http/routes/config.cpp
 * @brief Configuration management routes
 */

#include <unordered_map>

#include "vayu/core/config_manager.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/logger.hpp"

namespace vayu::http::routes {

void register_config_routes(RouteContext& ctx) {
    /**
     * GET /config
     * Retrieves all configuration entries with metadata for UI display.
     */
    ctx.server.Get("/config", [&ctx](const httplib::Request&, httplib::Response& res) {
        vayu::utils::log_info("GET /config - Fetching configuration entries");
        try {
            auto& config_mgr = vayu::core::ConfigManager::instance();
            auto entries = config_mgr.get_all_entries();

            nlohmann::json response;
            nlohmann::json entries_array = nlohmann::json::array();

            for (const auto& entry : entries) {
                nlohmann::json entry_json;
                entry_json["key"] = entry.key;
                entry_json["value"] = entry.value;
                entry_json["type"] = entry.type;
                entry_json["label"] = entry.label;
                entry_json["description"] = entry.description;
                entry_json["category"] = entry.category;
                entry_json["default"] = entry.default_value;
                if (entry.min_value) {
                    entry_json["min"] = *entry.min_value;
                }
                if (entry.max_value) {
                    entry_json["max"] = *entry.max_value;
                }
                entry_json["updatedAt"] = entry.updated_at;
                entries_array.push_back(entry_json);
            }

            response["entries"] = entries_array;
            res.set_content(response.dump(2), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error("GET /config - Error: " + std::string(e.what()));
            send_error(res, 500, e.what());
        }
    });

    /**
     * POST /config
     * Updates configuration entries.
     * Body: { "entries": { "key1": "value1", "key2": "value2", ... } }
     * Or: { "key": "key1", "value": "value1" } for single update
     */
    ctx.server.Post("/config", [&ctx](const httplib::Request& req, httplib::Response& res) {
        vayu::utils::log_info("POST /config - Updating configuration");
        try {
            auto json = nlohmann::json::parse(req.body);
            auto& config_mgr = vayu::core::ConfigManager::instance();

            std::unordered_map<std::string, std::string> updates;

            // Handle bulk update format: { "entries": { "key": "value", ... } }
            if (json.contains("entries") && json["entries"].is_object()) {
                for (const auto& [key, value] : json["entries"].items()) {
                    if (value.is_string()) {
                        updates[key] = value.get<std::string>();
                    } else if (value.is_number()) {
                        updates[key] = std::to_string(value.get<double>());
                    } else if (value.is_boolean()) {
                        updates[key] = value.get<bool>() ? "true" : "false";
                    } else {
                        updates[key] = value.dump();
                    }
                }
            }
            // Handle single update format: { "key": "key1", "value": "value1" }
            else if (json.contains("key") && json.contains("value")) {
                std::string key = json["key"].get<std::string>();
                std::string value;
                if (json["value"].is_string()) {
                    value = json["value"].get<std::string>();
                } else if (json["value"].is_number()) {
                    value = std::to_string(json["value"].get<double>());
                } else if (json["value"].is_boolean()) {
                    value = json["value"].get<bool>() ? "true" : "false";
                } else {
                    value = json["value"].dump();
                }
                updates[key] = value;
            } else {
                send_error(res, 400, "Invalid request format. Expected { \"entries\": {...} } or { \"key\": \"...\", \"value\": \"...\" }");
                return;
            }

            if (updates.empty()) {
                send_error(res, 400, "No updates provided");
                return;
            }

            bool success = config_mgr.update_entries(updates);
            if (!success) {
                send_error(res, 400, "Failed to update configuration. Check logs for details.");
                return;
            }

            // Reload cache to ensure consistency
            config_mgr.reload();

            // Return updated entries
            auto entries = config_mgr.get_all_entries();
            nlohmann::json response;
            nlohmann::json entries_array = nlohmann::json::array();

            for (const auto& entry : entries) {
                nlohmann::json entry_json;
                entry_json["key"] = entry.key;
                entry_json["value"] = entry.value;
                entry_json["type"] = entry.type;
                entry_json["label"] = entry.label;
                entry_json["description"] = entry.description;
                entry_json["category"] = entry.category;
                entry_json["default"] = entry.default_value;
                if (entry.min_value) {
                    entry_json["min"] = *entry.min_value;
                }
                if (entry.max_value) {
                    entry_json["max"] = *entry.max_value;
                }
                entry_json["updatedAt"] = entry.updated_at;
                entries_array.push_back(entry_json);
            }

            response["entries"] = entries_array;
            response["success"] = true;
            res.set_content(response.dump(2), "application/json");
        } catch (const nlohmann::json::parse_error& e) {
            vayu::utils::log_error("POST /config - JSON parse error: " + std::string(e.what()));
            send_error(res, 400, "Invalid JSON: " + std::string(e.what()));
        } catch (const std::exception& e) {
            vayu::utils::log_error("POST /config - Error: " + std::string(e.what()));
            send_error(res, 500, e.what());
        }
    });
}

}  // namespace vayu::http::routes

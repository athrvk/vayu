#pragma once

#include <memory>
#include <nlohmann/json.hpp>
#include <string>

#include "vayu/db/database.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

struct RunContext;  // Forward declaration

/**
 * @brief Interface for load testing strategies
 */
class LoadStrategy {
public:
    virtual ~LoadStrategy() = default;

    /**
     * @brief Execute the load test strategy
     * @param context The run context
     * @param db Database for storing results
     * @param request The request to execute
     */
    virtual void execute(std::shared_ptr<RunContext> context,
                         vayu::db::Database& db,
                         const vayu::Request& request) = 0;

    /**
     * @brief Create a strategy instance based on configuration
     */
    static std::unique_ptr<LoadStrategy> create(const nlohmann::json& config);
};

}  // namespace vayu::core

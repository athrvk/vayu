/**
 * @file main.cpp
 * @brief Vayu CLI entry point
 *
 * Usage:
 *   vayu-cli run <request.json>   - Execute a request from JSON file
 *   vayu-cli --version            - Show version
 *   vayu-cli --help               - Show help
 */

#include <httplib.h>

#include "vayu/core/constants.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"
#ifdef VAYU_HAS_QUICKJS
#include "vayu/runtime/script_engine.hpp"
#endif

#include <chrono>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {
// Default daemon URL
const std::string DEFAULT_DAEMON_URL = vayu::core::constants::defaults::DAEMON_URL;

void print_version() {
    std::cout << "vayu-cli " << vayu::Version::string << "\n";
    vayu::utils::log_info("vayu-cli " + std::string(vayu::Version::string));
}

void print_help() {
    std::cout << R"(
Vayu CLI - High-Performance API Testing Tool

USAGE:
    vayu-cli <COMMAND> [OPTIONS]

COMMANDS:
    run <file>          Execute a request or load test via the daemon
    
OPTIONS:
    -h, --help          Show this help message
    -v, --version       Show version information
    --verbose           Enable verbose output
    --no-color          Disable colored output
    --daemon <url>      Vayu Engine URL (default: http://127.0.0.1:9876)

EXAMPLES:
    vayu-cli run request.json
    vayu-cli run load-test.json --daemon http://localhost:9876

REQUEST FILE FORMAT:
    See documentation for request and load test configuration formats.

For more information, visit: https://github.com/vayu/vayu
)";
}

std::string read_file(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open file: " + path);
    }

    std::string content;
    file.seekg(0, std::ios::end);
    content.reserve(static_cast<size_t>(file.tellg()));
    file.seekg(0, std::ios::beg);

    content.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());

    return content;
}

void print_response(const vayu::Response& response, bool color) {
    // Status line
    const char* status_color = "";
    const char* reset = "";

    if (color) {
        reset = "\033[0m";
        if (response.is_success()) {
            status_color = "\033[32m";  // Green
        } else if (response.is_redirect()) {
            status_color = "\033[33m";  // Yellow
        } else {
            status_color = "\033[31m";  // Red
        }
    }

    std::cout << "\n";
    std::cout << status_color << response.status_code << " " << response.status_text << reset
              << "\n";
    std::cout << "Time: " << response.timing.total_ms << " ms\n";
    std::cout << "Size: " << response.body_size << " bytes\n";
    std::cout << "\n";

    // Headers
    std::cout << "Headers:\n";
    for (const auto& [key, value] : response.headers) {
        std::cout << "  " << key << ": " << value << "\n";
    }
    std::cout << "\n";

    // Body
    std::cout << "Body:\n";
    if (auto json = vayu::json::try_parse_body(response.body)) {
        std::cout << vayu::json::pretty_print(*json, color) << "\n";
    } else {
        std::cout << response.body << "\n";
    }
}

void print_error(const vayu::Error& error, bool color) {
    const char* red = color ? "\033[31m" : "";
    const char* reset = color ? "\033[0m" : "";

    std::string msg = "Error: " + std::string(vayu::to_string(error.code));
    std::cerr << red << msg << reset << "\n";
    std::cerr << error.message << "\n";

    vayu::utils::log_error(msg);
    vayu::utils::log_error(error.message);
}

vayu::Response parse_daemon_response(const std::string& json_str) {
    auto json = nlohmann::json::parse(json_str);
    vayu::Response response;

    response.status_code = json.value("status", 0);
    response.status_text = json.value("statusText", "");
    response.body = json.value("bodyRaw", "");
    response.body_size = response.body.size();

    if (json.contains("headers")) {
        for (const auto& item : json["headers"].items()) {
            response.headers[item.key()] = item.value().get<std::string>();
        }
    }

    if (json.contains("timing")) {
        const auto& t = json["timing"];
        response.timing.total_ms = t.value("total", 0.0);
        response.timing.dns_ms = t.value("dns", 0.0);
        response.timing.connect_ms = t.value("connect", 0.0);
        response.timing.tls_ms = t.value("tls", 0.0);
        response.timing.first_byte_ms = t.value("firstByte", 0.0);
        response.timing.download_ms = t.value("download", 0.0);
    }

    return response;
}

int run_via_daemon(const std::string& daemon_url,
                   const std::string& filepath,
                   bool verbose,
                   bool color) {
    // Read request file
    std::string content;
    try {
        content = read_file(filepath);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        vayu::utils::log_error("Error: " + std::string(e.what()));
        return 1;
    }

    // Parse JSON to determine mode
    auto json_result = vayu::json::parse(content);
    if (json_result.is_error()) {
        print_error(json_result.error(), color);
        return 1;
    }

    const auto& json = json_result.value();
    bool is_load_test =
        json.contains("mode") || json.contains("iterations") || json.contains("duration");

    httplib::Client cli(daemon_url);
    cli.set_connection_timeout(5);  // 5s connection timeout

    if (verbose) {
        vayu::utils::log_info("Connecting to daemon at " + daemon_url + "...");
    }

    if (is_load_test) {
        // Load Test -> POST /run
        auto res = cli.Post("/run", content, "application/json");

        if (!res) {
            vayu::utils::log_error("Error: Failed to connect to daemon at " + daemon_url);
            return 1;
        }

        if (res->status == 202) {
            auto response_json = nlohmann::json::parse(res->body);
            std::string run_id = response_json["runId"];
            vayu::utils::log_info("Load test started successfully.");
            std::cout << "Run ID: " << run_id << "\n";
            vayu::utils::log_info("Monitor status at: " + daemon_url + "/stats/" + run_id);
            return 0;
        } else {
            std::string msg =
                "Error starting load test (Status " + std::to_string(res->status) + ")";
            std::cerr << msg << "\n";
            std::cerr << res->body << "\n";
            vayu::utils::log_error(msg);
            vayu::utils::log_error(res->body);
            return 1;
        }
    } else {
        // Single Request -> POST /request
        // Note: The daemon expects the raw JSON request definition
        auto res = cli.Post("/request", content, "application/json");

        if (!res) {
            std::string msg = "Error: Failed to connect to daemon at " + daemon_url;
            std::cerr << msg << "\n";
            vayu::utils::log_error(msg);
            return 1;
        }

        if (res->status == 200) {
            try {
                auto response = parse_daemon_response(res->body);
                print_response(response, color);
                return 0;
            } catch (const std::exception& e) {
                std::string msg = "Error parsing daemon response: " + std::string(e.what());
                std::cerr << msg << "\n";
                vayu::utils::log_error(msg);
                return 1;
            }
        } else {
            std::string msg = "Request failed (Status " + std::to_string(res->status) + ")";
            std::cerr << msg << "\n";
            std::cerr << res->body << "\n";
            vayu::utils::log_error(msg);
            vayu::utils::log_error(res->body);
            return 1;
        }
    }
}

}  // namespace

int main(int argc, char* argv[]) {
    // Parse arguments
    if (argc < 2) {
        print_help();
        return 1;
    }

    std::string command = argv[1];
    bool verbose = false;
    bool color = true;
    std::string filepath;
    std::string daemon_url = DEFAULT_DAEMON_URL;

    // Parse flags
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == "-h" || arg == "--help") {
            print_help();
            return 0;
        }

        if (arg == "-v" || arg == "--version") {
            print_version();
            return 0;
        }

        if (arg == "--verbose") {
            verbose = true;
            continue;
        }

        if (arg == "--no-color") {
            color = false;
            continue;
        }

        if (arg == "--daemon" && i + 1 < argc) {
            daemon_url = argv[++i];
            continue;
        }

        if (arg == "run" && i + 1 < argc) {
            filepath = argv[++i];
            continue;
        }

        // First non-flag argument after 'run' is the filepath
        if (command == "run" && filepath.empty() && arg[0] != '-') {
            filepath = arg;
        }
    }

    // Initialize curl (still needed for httplib?)
    // httplib uses its own socket implementation, but vayu::http::global_init might be needed if we
    // use other vayu components. However, we are not using vayu::http::Client anymore.
    // vayu::http::global_init();

    int result = 0;

    if (command == "run") {
        if (filepath.empty()) {
            std::string msg = "Error: Missing request file";
            std::cerr << msg << "\n";
            std::cerr << "Usage: vayu-cli run <request.json>\n";
            vayu::utils::log_error(msg);
            result = 1;
        } else {
            result = run_via_daemon(daemon_url, filepath, verbose, color);
        }
    } else if (command[0] == '-') {
        // Already handled flags above
        result = 0;
    } else {
        std::string msg = "Error: Unknown command '" + command + "'";
        std::cerr << msg << "\n";
        std::cerr << "Run 'vayu-cli --help' for usage information.\n";
        vayu::utils::log_error(msg);
        result = 1;
    }

    // Cleanup
    // vayu::http::global_cleanup();

    return result;
}

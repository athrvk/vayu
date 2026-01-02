/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include "vayu/http/client.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/version.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <csignal>
#include <iostream>
#include <thread>

namespace
{

    std::atomic<bool> g_running{true};

    void signal_handler(int signal)
    {
        if (signal == SIGINT || signal == SIGTERM)
        {
            std::cout << "\nShutting down...\n";
            g_running = false;
        }
    }

} // namespace

int main(int argc, char *argv[])
{
    // Parse arguments
    int port = 9876;
    bool verbose = false;

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == "-p" || arg == "--port")
        {
            if (i + 1 < argc)
            {
                port = std::stoi(argv[++i]);
            }
        }
        else if (arg == "-v" || arg == "--verbose")
        {
            verbose = true;
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
            std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
            std::cout << "Options:\n";
            std::cout << "  -p, --port <PORT>  Port to listen on (default: 9876)\n";
            std::cout << "  -v, --verbose      Enable verbose output\n";
            std::cout << "  -h, --help         Show this help message\n";
            return 0;
        }
    }

    // Setup signal handlers
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Initialize curl
    vayu::http::global_init();

    // Create HTTP server
    httplib::Server server;

    // Health check endpoint
    server.Get("/health", [](const httplib::Request &, httplib::Response &res)
               {
        nlohmann::json response;
        response["status"] = "ok";
        response["version"] = vayu::Version::string;
        response["workers"] = std::thread::hardware_concurrency();
        
        res.set_content(response.dump(), "application/json"); });

    // Single request endpoint (Design Mode)
    server.Post("/request", [verbose](const httplib::Request &req, httplib::Response &res)
                {
        try {
            // Parse request body
            auto json = nlohmann::json::parse(req.body);
            
            // Deserialize to vayu::Request
            auto request_result = vayu::json::deserialize_request(json);
            if (request_result.is_error()) {
                res.status = 400;
                res.set_content(vayu::json::serialize(request_result.error()).dump(), 
                               "application/json");
                return;
            }
            
            // Send request
            vayu::http::ClientConfig config;
            config.verbose = verbose;
            vayu::http::Client client(config);
            
            auto response_result = client.send(request_result.value());
            
            if (response_result.is_error()) {
                res.status = 502;
                res.set_content(vayu::json::serialize(response_result.error()).dump(),
                               "application/json");
                return;
            }
            
            // Return response
            res.set_content(vayu::json::serialize(response_result.value()).dump(2),
                           "application/json");
                           
        } catch (const std::exception& e) {
            res.status = 400;
            nlohmann::json error;
            error["error"]["code"] = "INVALID_REQUEST";
            error["error"]["message"] = e.what();
            res.set_content(error.dump(), "application/json");
        } });

    // Load test endpoint (Vayu Mode) - placeholder
    server.Post("/run", [](const httplib::Request &req, httplib::Response &res)
                {
        // TODO: Implement load testing in Phase 2
        nlohmann::json response;
        response["runId"] = "run_" + std::to_string(std::time(nullptr));
        response["status"] = "starting";
        response["message"] = "Load testing not yet implemented";
        
        res.status = 501;  // Not Implemented
        res.set_content(response.dump(), "application/json"); });

    // Configuration endpoint
    server.Get("/config", [](const httplib::Request &, httplib::Response &res)
               {
        nlohmann::json config;
        config["workers"] = std::thread::hardware_concurrency();
        config["maxConnections"] = 10000;
        config["defaultTimeout"] = 30000;
        config["statsInterval"] = 100;
        config["contextPoolSize"] = 64;
        
        res.set_content(config.dump(2), "application/json"); });

    // Start server
    std::cout << "Vayu Engine " << vayu::Version::string << "\n";
    std::cout << "Listening on http://127.0.0.1:" << port << "\n";
    std::cout << "Press Ctrl+C to stop\n\n";

    // Run in a thread so we can check g_running
    std::thread server_thread([&server, port]()
                              { server.listen("127.0.0.1", port); });

    // Wait for shutdown signal
    while (g_running && server.is_running())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Shutdown
    server.stop();
    if (server_thread.joinable())
    {
        server_thread.join();
    }

    vayu::http::global_cleanup();

    std::cout << "Goodbye!\n";
    return 0;
}

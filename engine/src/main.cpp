/**
 * @file main.cpp
 * @brief Vayu CLI entry point
 *
 * Usage:
 *   vayu-cli run <request.json>   - Execute a request from JSON file
 *   vayu-cli --version            - Show version
 *   vayu-cli --help               - Show help
 */

#include "vayu/http/client.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/version.hpp"
#ifdef VAYU_HAS_QUICKJS
#include "vayu/runtime/script_engine.hpp"
#endif

#include <chrono>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace
{

    void print_version()
    {
        std::cout << "vayu-cli " << vayu::Version::string << "\n";
    }

    void print_help()
    {
        std::cout << R"(
Vayu CLI - High-Performance API Testing Tool

USAGE:
    vayu-cli <COMMAND> [OPTIONS]

COMMANDS:
    run <file>          Execute a single request from JSON file
    batch <files...>    Execute multiple requests in parallel
    
OPTIONS:
    -h, --help          Show this help message
    -v, --version       Show version information
    --verbose           Enable verbose output
    --no-color          Disable colored output
    --concurrency <n>   Max concurrent requests for batch (default: 10)

EXAMPLES:
    vayu-cli run request.json
    vayu-cli run request.json --verbose
    vayu-cli batch req1.json req2.json req3.json
    vayu-cli batch *.json --concurrency 20

REQUEST FILE FORMAT:
    {
        "method": "GET",
        "url": "https://api.example.com/users",
        "headers": {
            "Authorization": "Bearer token"
        },
        "timeout": 30000,
        "tests": "pm.test('Status is 200', function() { pm.expect(pm.response.code).to.equal(200); });"
    }

For more information, visit: https://github.com/vayu/vayu
)";
    }

    std::string read_file(const std::string &path)
    {
        std::ifstream file(path);
        if (!file.is_open())
        {
            throw std::runtime_error("Failed to open file: " + path);
        }

        std::string content;
        file.seekg(0, std::ios::end);
        content.reserve(static_cast<size_t>(file.tellg()));
        file.seekg(0, std::ios::beg);

        content.assign(
            std::istreambuf_iterator<char>(file),
            std::istreambuf_iterator<char>());

        return content;
    }

    void print_response(const vayu::Response &response, bool color)
    {
        // Status line
        const char *status_color = "";
        const char *reset = "";

        if (color)
        {
            reset = "\033[0m";
            if (response.is_success())
            {
                status_color = "\033[32m"; // Green
            }
            else if (response.is_redirect())
            {
                status_color = "\033[33m"; // Yellow
            }
            else
            {
                status_color = "\033[31m"; // Red
            }
        }

        std::cout << "\n";
        std::cout << status_color << response.status_code << " "
                  << response.status_text << reset << "\n";
        std::cout << "Time: " << response.timing.total_ms << " ms\n";
        std::cout << "Size: " << response.body_size << " bytes\n";
        std::cout << "\n";

        // Headers
        std::cout << "Headers:\n";
        for (const auto &[key, value] : response.headers)
        {
            std::cout << "  " << key << ": " << value << "\n";
        }
        std::cout << "\n";

        // Body
        std::cout << "Body:\n";
        if (auto json = vayu::json::try_parse_body(response.body))
        {
            std::cout << vayu::json::pretty_print(*json, color) << "\n";
        }
        else
        {
            std::cout << response.body << "\n";
        }
    }

    void print_error(const vayu::Error &error, bool color)
    {
        const char *red = color ? "\033[31m" : "";
        const char *reset = color ? "\033[0m" : "";

        std::cerr << red << "Error: " << vayu::to_string(error.code) << reset << "\n";
        std::cerr << error.message << "\n";
    }

#ifdef VAYU_HAS_QUICKJS
    void print_test_results(const vayu::ScriptResult &result, bool color)
    {
        const char *green = color ? "\033[32m" : "";
        const char *red = color ? "\033[31m" : "";
        const char *reset = color ? "\033[0m" : "";
        const char *dim = color ? "\033[90m" : "";

        if (result.tests.empty())
        {
            return;
        }

        std::cout << "\n";
        std::cout << "Test Results:\n";

        int passed = 0;
        int failed = 0;

        for (const auto &test : result.tests)
        {
            if (test.passed)
            {
                std::cout << "  " << green << "✓" << reset << " " << test.name << "\n";
                passed++;
            }
            else
            {
                std::cout << "  " << red << "✗" << reset << " " << test.name << "\n";
                if (!test.error_message.empty())
                {
                    std::cout << "    " << dim << test.error_message << reset << "\n";
                }
                failed++;
            }
        }

        std::cout << "\n";
        std::cout << green << passed << " passed" << reset;
        if (failed > 0)
        {
            std::cout << ", " << red << failed << " failed" << reset;
        }
        std::cout << "\n";
    }
#endif

    int run_request(const std::string &filepath, bool verbose, bool color)
    {
        // Read request file
        std::string content;
        try
        {
            content = read_file(filepath);
        }
        catch (const std::exception &e)
        {
            std::cerr << "Error: " << e.what() << "\n";
            return 1;
        }

        // Parse JSON to get both request and test script
        auto json_result = vayu::json::parse(content);
        if (json_result.is_error())
        {
            print_error(json_result.error(), color);
            return 1;
        }

        const auto &json = json_result.value();

        // Extract test script if present
        std::string test_script;
        if (json.contains("tests") && json["tests"].is_string())
        {
            test_script = json["tests"].get<std::string>();
        }

        // Parse request JSON
        auto request_result = vayu::json::deserialize_request(content);
        if (request_result.is_error())
        {
            print_error(request_result.error(), color);
            return 1;
        }

        const auto &request = request_result.value();

        if (verbose)
        {
            std::cout << "Request:\n";
            std::cout << "  Method: " << vayu::to_string(request.method) << "\n";
            std::cout << "  URL: " << request.url << "\n";
            std::cout << "  Timeout: " << request.timeout_ms << " ms\n";
            std::cout << "\n";
        }

        // Create client and send request
        vayu::http::ClientConfig config;
        config.verbose = verbose;

        vayu::http::Client client(config);
        auto response_result = client.send(request);

        if (response_result.is_error())
        {
            print_error(response_result.error(), color);
            return 1;
        }

        const auto &response = response_result.value();

        // Print response
        print_response(response, color);

        // Run tests if script present
#ifdef VAYU_HAS_QUICKJS
        if (!test_script.empty())
        {
            vayu::runtime::ScriptEngine engine;
            vayu::Environment env;
            auto script_result = engine.execute_test(test_script, request, response, env);
            print_test_results(script_result, color);

            // Print console output if any
            if (!script_result.console_output.empty() && verbose)
            {
                const char *dim = color ? "\033[90m" : "";
                const char *reset = color ? "\033[0m" : "";
                std::cout << "\nConsole Output:\n";
                for (const auto &line : script_result.console_output)
                {
                    std::cout << "  " << dim << line << reset << "\n";
                }
            }

            // Return error code if tests failed
            if (!script_result.success)
            {
                return 1;
            }
        }
#else
        if (!test_script.empty())
        {
            std::cerr << "Warning: Tests specified but QuickJS scripting not available\n";
        }
#endif

        return 0;
    }

    int run_batch(const std::vector<std::string> &filepaths, bool verbose, bool color, size_t concurrency)
    {
        if (filepaths.empty())
        {
            std::cerr << "Error: No request files specified\n";
            return 1;
        }

        const char *green = color ? "\033[32m" : "";
        const char *red = color ? "\033[31m" : "";
        const char *cyan = color ? "\033[36m" : "";
        const char *reset = color ? "\033[0m" : "";
        const char *dim = color ? "\033[90m" : "";

        // Parse all request files
        std::vector<vayu::Request> requests;
        std::vector<std::string> request_names;
        requests.reserve(filepaths.size());
        request_names.reserve(filepaths.size());

        for (const auto &filepath : filepaths)
        {
            std::string content;
            try
            {
                content = read_file(filepath);
            }
            catch (const std::exception &e)
            {
                std::cerr << red << "Error reading " << filepath << ": " << e.what() << reset << "\n";
                continue;
            }

            auto request_result = vayu::json::deserialize_request(content);
            if (request_result.is_error())
            {
                std::cerr << red << "Error parsing " << filepath << ": "
                          << request_result.error().message << reset << "\n";
                continue;
            }

            requests.push_back(request_result.value());
            request_names.push_back(filepath);
        }

        if (requests.empty())
        {
            std::cerr << "Error: No valid requests to execute\n";
            return 1;
        }

        std::cout << cyan << "Running " << requests.size() << " requests with concurrency "
                  << concurrency << "..." << reset << "\n\n";

        // Create event loop and execute batch
        vayu::http::EventLoopConfig config;
        config.max_concurrent = concurrency;
        config.verbose = verbose;

        vayu::http::EventLoop loop(config);
        loop.start();

        auto start_time = std::chrono::steady_clock::now();
        auto batch_result = loop.execute_batch(requests);
        auto end_time = std::chrono::steady_clock::now();

        loop.stop();

        // Print results
        size_t success_count = 0;
        size_t fail_count = 0;

        for (size_t i = 0; i < batch_result.responses.size(); ++i)
        {
            const auto &name = request_names[i];
            const auto &result = batch_result.responses[i];

            if (result.is_ok())
            {
                const auto &response = result.value();
                const char *status_color = response.is_success() ? green : red;

                if (verbose)
                {
                    std::cout << status_color << "✓" << reset << " " << name << " - "
                              << response.status_code << " " << response.status_text
                              << dim << " (" << response.timing.total_ms << " ms)" << reset << "\n";
                }
                else
                {
                    std::cout << status_color << "✓" << reset << " " << name << " - "
                              << response.status_code << "\n";
                }

                if (response.is_success())
                {
                    success_count++;
                }
                else
                {
                    fail_count++;
                }
            }
            else
            {
                std::cout << red << "✗" << reset << " " << name << " - "
                          << result.error().message << "\n";
                fail_count++;
            }
        }

        // Print summary
        auto total_time = std::chrono::duration<double, std::milli>(end_time - start_time).count();

        std::cout << "\n";
        std::cout << dim << "────────────────────────────────────────" << reset << "\n";
        std::cout << "Total: " << batch_result.responses.size() << " requests in "
                  << total_time << " ms\n";
        std::cout << green << success_count << " successful" << reset;
        if (fail_count > 0)
        {
            std::cout << ", " << red << fail_count << " failed" << reset;
        }
        std::cout << "\n";

        double avg_time = total_time / static_cast<double>(batch_result.responses.size());
        std::cout << dim << "Average: " << avg_time << " ms/request" << reset << "\n";

        return fail_count > 0 ? 1 : 0;
    }

} // namespace

int main(int argc, char *argv[])
{
    // Parse arguments
    if (argc < 2)
    {
        print_help();
        return 1;
    }

    std::string command = argv[1];
    bool verbose = false;
    bool color = true;
    std::string filepath;
    std::vector<std::string> batch_files;
    size_t concurrency = 10;

    // Parse flags
    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == "-h" || arg == "--help")
        {
            print_help();
            return 0;
        }

        if (arg == "-v" || arg == "--version")
        {
            print_version();
            return 0;
        }

        if (arg == "--verbose")
        {
            verbose = true;
            continue;
        }

        if (arg == "--no-color")
        {
            color = false;
            continue;
        }

        if (arg == "--concurrency" && i + 1 < argc)
        {
            concurrency = static_cast<size_t>(std::stoi(argv[++i]));
            continue;
        }

        if (arg == "run" && i + 1 < argc)
        {
            filepath = argv[++i];
            continue;
        }

        if (arg == "batch")
        {
            // Collect all remaining non-flag arguments as batch files
            for (int j = i + 1; j < argc; ++j)
            {
                std::string batch_arg = argv[j];
                if (batch_arg[0] == '-')
                {
                    break;
                }
                batch_files.push_back(batch_arg);
            }
            continue;
        }

        // First non-flag argument after 'run' is the filepath
        if (command == "run" && filepath.empty() && arg[0] != '-')
        {
            filepath = arg;
        }
    }

    // Initialize curl
    vayu::http::global_init();

    int result = 0;

    if (command == "run")
    {
        if (filepath.empty())
        {
            std::cerr << "Error: Missing request file\n";
            std::cerr << "Usage: vayu-cli run <request.json>\n";
            result = 1;
        }
        else
        {
            result = run_request(filepath, verbose, color);
        }
    }
    else if (command == "batch")
    {
        if (batch_files.empty())
        {
            std::cerr << "Error: No request files specified\n";
            std::cerr << "Usage: vayu-cli batch <file1.json> <file2.json> ...\n";
            result = 1;
        }
        else
        {
            result = run_batch(batch_files, verbose, color, concurrency);
        }
    }
    else if (command[0] == '-')
    {
        // Already handled flags above
        result = 0;
    }
    else
    {
        std::cerr << "Error: Unknown command '" << command << "'\n";
        std::cerr << "Run 'vayu-cli --help' for usage information.\n";
        result = 1;
    }

    // Cleanup
    vayu::http::global_cleanup();

    return result;
}

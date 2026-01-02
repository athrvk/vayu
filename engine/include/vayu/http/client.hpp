#pragma once

/**
 * @file http/client.hpp
 * @brief HTTP client using libcurl
 */

#include "vayu/types.hpp"
#include "vayu/core/constants.hpp"

#include <memory>

namespace vayu::http
{

    /**
     * @brief HTTP Client configuration
     */
    struct ClientConfig
    {
        std::string user_agent = vayu::core::constants::defaults::DEFAULT_USER_AGENT;
        bool verbose = vayu::core::constants::defaults::VERBOSE;
        std::string proxy_url;
        std::string ca_bundle_path;
    };

    /**
     * @brief HTTP Client for making requests
     *
     * This is the simple synchronous client using curl_easy.
     * For high-concurrency scenarios, see EventLoop which uses curl_multi.
     */
    class Client
    {
    public:
        /**
         * @brief Construct a new Client
         */
        explicit Client(ClientConfig config = {});

        /**
         * @brief Destructor
         */
        ~Client();

        // Non-copyable
        Client(const Client &) = delete;
        Client &operator=(const Client &) = delete;

        // Movable
        Client(Client &&) noexcept;
        Client &operator=(Client &&) noexcept;

        /**
         * @brief Send an HTTP request and return the response
         *
         * @param request The request to send
         * @return Result<Response> The response or an error
         */
        [[nodiscard]] Result<Response> send(const Request &request);

        /**
         * @brief Convenience method for GET requests
         */
        [[nodiscard]] Result<Response> get(const std::string &url,
                                           const Headers &headers = {});

        /**
         * @brief Convenience method for POST requests
         */
        [[nodiscard]] Result<Response> post(const std::string &url,
                                            const std::string &body,
                                            const Headers &headers = {});

        /**
         * @brief Get the last error message from curl
         */
        [[nodiscard]] std::string last_error() const;

    private:
        struct Impl;
        std::unique_ptr<Impl> impl_;
    };

    /**
     * @brief Initialize curl globally (call once at startup)
     */
    void global_init();

    /**
     * @brief Cleanup curl globally (call once at shutdown)
     */
    void global_cleanup();

} // namespace vayu::http

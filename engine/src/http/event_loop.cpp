/**
 * @file http/event_loop.cpp
 * @brief Async HTTP event loop implementation using curl_multi
 */

#include "vayu/http/event_loop.hpp"
#include "vayu/http/client.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <unordered_map>

namespace vayu::http
{

    // ============================================================================
    // Helper Functions (shared with client.cpp)
    // ============================================================================

    namespace
    {

        /**
         * @brief Data associated with each transfer
         */
        struct TransferData
        {
            size_t request_id = 0;
            Request request;
            Response response;
            std::string response_body;
            RequestCallback callback;
            ProgressCallback progress;
            std::promise<Result<Response>> promise;
            bool has_promise = false;
            char error_buffer[CURL_ERROR_SIZE] = {0};
            struct curl_slist *headers_list = nullptr;

            ~TransferData()
            {
                if (headers_list)
                {
                    curl_slist_free_all(headers_list);
                }
            }
        };

        /**
         * @brief Callback for writing response body
         */
        size_t write_callback(char *ptr, size_t size, size_t nmemb, void *userdata)
        {
            auto *data = static_cast<TransferData *>(userdata);
            size_t total_size = size * nmemb;
            data->response_body.append(ptr, total_size);
            return total_size;
        }

        /**
         * @brief Callback for writing response headers
         */
        size_t header_callback(char *buffer, size_t size, size_t nitems, void *userdata)
        {
            auto *data = static_cast<TransferData *>(userdata);
            size_t total_size = size * nitems;

            std::string line(buffer, total_size);

            // Remove trailing \r\n
            while (!line.empty() && (line.back() == '\r' || line.back() == '\n'))
            {
                line.pop_back();
            }

            // Skip empty lines and status line
            if (line.empty() || line.starts_with("HTTP/"))
            {
                return total_size;
            }

            // Parse header: "Key: Value"
            auto colon_pos = line.find(':');
            if (colon_pos != std::string::npos)
            {
                std::string key = line.substr(0, colon_pos);
                std::string value = line.substr(colon_pos + 1);

                // Trim leading whitespace from value
                while (!value.empty() && value.front() == ' ')
                {
                    value.erase(0, 1);
                }

                // Convert key to lowercase for consistency
                for (auto &c : key)
                {
                    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                }

                data->response.headers[key] = value;
            }

            return total_size;
        }

        /**
         * @brief Progress callback wrapper
         */
        int progress_callback(void *clientp, curl_off_t dltotal, curl_off_t dlnow,
                              curl_off_t /*ultotal*/, curl_off_t /*ulnow*/)
        {
            auto *data = static_cast<TransferData *>(clientp);
            if (data->progress)
            {
                data->progress(data->request_id, static_cast<size_t>(dlnow),
                               static_cast<size_t>(dltotal));
            }
            return 0;
        }

        /**
         * @brief Convert curl error code to our Error
         */
        Error curl_to_error(CURLcode code, const char *error_buffer)
        {
            Error error;
            error.message = error_buffer[0] ? error_buffer : curl_easy_strerror(code);

            switch (code)
            {
            case CURLE_OK:
                error.code = ErrorCode::None;
                break;
            case CURLE_OPERATION_TIMEDOUT:
                error.code = ErrorCode::Timeout;
                break;
            case CURLE_COULDNT_CONNECT:
            case CURLE_COULDNT_RESOLVE_HOST:
            case CURLE_COULDNT_RESOLVE_PROXY:
                error.code = ErrorCode::ConnectionFailed;
                break;
            case CURLE_SSL_CONNECT_ERROR:
            case CURLE_SSL_CERTPROBLEM:
            case CURLE_SSL_CIPHER:
            case CURLE_PEER_FAILED_VERIFICATION:
                error.code = ErrorCode::SslError;
                break;
            case CURLE_URL_MALFORMAT:
                error.code = ErrorCode::InvalidUrl;
                break;
            default:
                error.code = ErrorCode::InternalError;
                break;
            }

            return error;
        }

        /**
         * @brief Get HTTP status text from code
         */
        const char *status_text(int code)
        {
            switch (code)
            {
            case 200:
                return "OK";
            case 201:
                return "Created";
            case 204:
                return "No Content";
            case 301:
                return "Moved Permanently";
            case 302:
                return "Found";
            case 304:
                return "Not Modified";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 408:
                return "Request Timeout";
            case 429:
                return "Too Many Requests";
            case 500:
                return "Internal Server Error";
            case 502:
                return "Bad Gateway";
            case 503:
                return "Service Unavailable";
            case 504:
                return "Gateway Timeout";
            default:
                return "Unknown";
            }
        }

        /**
         * @brief Setup a CURL easy handle for a request
         */
        CURL *setup_easy_handle(TransferData *data, const EventLoopConfig &config)
        {
            CURL *curl = curl_easy_init();
            if (!curl)
            {
                return nullptr;
            }

            const Request &request = data->request;

            // Set error buffer
            curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, data->error_buffer);

            // Set URL
            curl_easy_setopt(curl, CURLOPT_URL, request.url.c_str());

            // Set method
            switch (request.method)
            {
            case HttpMethod::GET:
                curl_easy_setopt(curl, CURLOPT_HTTPGET, 1L);
                break;
            case HttpMethod::POST:
                curl_easy_setopt(curl, CURLOPT_POST, 1L);
                break;
            case HttpMethod::PUT:
                curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
                break;
            case HttpMethod::DELETE:
                curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
                break;
            case HttpMethod::PATCH:
                curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PATCH");
                break;
            case HttpMethod::HEAD:
                curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
                break;
            case HttpMethod::OPTIONS:
                curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "OPTIONS");
                break;
            }

            // Set request body
            if (request.body.mode != BodyMode::None && !request.body.content.empty())
            {
                curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.body.content.c_str());
                curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE,
                                 static_cast<long>(request.body.content.size()));
            }

            // Set headers
            for (const auto &[key, value] : request.headers)
            {
                std::string header = key + ": " + value;
                data->headers_list = curl_slist_append(data->headers_list, header.c_str());
            }

            // Add User-Agent if not set
            bool has_user_agent = request.headers.contains("User-Agent") ||
                                  request.headers.contains("user-agent");
            if (!has_user_agent)
            {
                std::string ua = "User-Agent: " + config.user_agent;
                data->headers_list = curl_slist_append(data->headers_list, ua.c_str());
            }

            if (data->headers_list)
            {
                curl_easy_setopt(curl, CURLOPT_HTTPHEADER, data->headers_list);
            }

            // Set callbacks
            curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_callback);
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, data);
            curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, header_callback);
            curl_easy_setopt(curl, CURLOPT_HEADERDATA, data);

            // Progress callback
            if (data->progress)
            {
                curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, progress_callback);
                curl_easy_setopt(curl, CURLOPT_XFERINFODATA, data);
                curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
            }

            // Set timeout
            curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeout_ms));

            // Set redirect options
            if (request.follow_redirects)
            {
                curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
                curl_easy_setopt(curl, CURLOPT_MAXREDIRS,
                                 static_cast<long>(request.max_redirects));
            }

            // SSL verification
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, request.verify_ssl ? 1L : 0L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, request.verify_ssl ? 2L : 0L);

            // Verbose output for debugging
            if (config.verbose)
            {
                curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
            }

            // Proxy
            if (!config.proxy_url.empty())
            {
                curl_easy_setopt(curl, CURLOPT_PROXY, config.proxy_url.c_str());
            }

            // Store private data pointer
            curl_easy_setopt(curl, CURLOPT_PRIVATE, data);

            return curl;
        }

        /**
         * @brief Extract response from completed transfer
         */
        Result<Response> extract_response(CURL *curl, TransferData *data, CURLcode result)
        {
            if (result != CURLE_OK)
            {
                return curl_to_error(result, data->error_buffer);
            }

            Response &response = data->response;

            // Get response info
            long http_code = 0;
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
            response.status_code = static_cast<int>(http_code);
            response.status_text = status_text(response.status_code);

            // Get timing info
            double total_time = 0, namelookup_time = 0, connect_time = 0;
            double appconnect_time = 0, starttransfer_time = 0;

            curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &total_time);
            curl_easy_getinfo(curl, CURLINFO_NAMELOOKUP_TIME, &namelookup_time);
            curl_easy_getinfo(curl, CURLINFO_CONNECT_TIME, &connect_time);
            curl_easy_getinfo(curl, CURLINFO_APPCONNECT_TIME, &appconnect_time);
            curl_easy_getinfo(curl, CURLINFO_STARTTRANSFER_TIME, &starttransfer_time);

            response.timing.total_ms = total_time * 1000.0;
            response.timing.dns_ms = namelookup_time * 1000.0;
            response.timing.connect_ms = (connect_time - namelookup_time) * 1000.0;
            response.timing.tls_ms = (appconnect_time - connect_time) * 1000.0;
            response.timing.first_byte_ms = (starttransfer_time - appconnect_time) * 1000.0;
            response.timing.download_ms = (total_time - starttransfer_time) * 1000.0;

            // Set body
            response.body = std::move(data->response_body);
            response.body_size = response.body.size();

            return response;
        }

    } // namespace

    // ============================================================================
    // EventLoop Implementation
    // ============================================================================

    struct EventLoop::Impl
    {
        EventLoopConfig config;
        CURLM *multi_handle = nullptr;

        std::thread worker_thread;
        std::atomic<bool> running{false};
        std::atomic<bool> stop_requested{false};

        mutable std::mutex queue_mutex_;
        std::condition_variable queue_cv;
        std::queue<std::unique_ptr<TransferData>> pending_queue;

        mutable std::mutex active_mutex_;
        std::unordered_map<CURL *, std::unique_ptr<TransferData>> active_transfers;

        std::atomic<size_t> next_request_id{1};
        std::atomic<size_t> total_processed{0};

        explicit Impl(EventLoopConfig cfg) : config(std::move(cfg))
        {
            multi_handle = curl_multi_init();
            if (!multi_handle)
            {
                throw std::runtime_error("Failed to initialize curl_multi");
            }

            // Set multi handle options
            curl_multi_setopt(multi_handle, CURLMOPT_MAXCONNECTS,
                              static_cast<long>(config.max_concurrent));
            curl_multi_setopt(multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS,
                              static_cast<long>(config.max_per_host));
        }

        ~Impl()
        {
            stop(false);

            if (multi_handle)
            {
                curl_multi_cleanup(multi_handle);
            }
        }

        void start()
        {
            if (running.exchange(true))
            {
                return; // Already running
            }

            stop_requested = false;
            worker_thread = std::thread(&Impl::run_loop, this);
        }

        void stop(bool wait_for_pending)
        {
            if (!running)
            {
                return;
            }

            stop_requested = true;

            if (!wait_for_pending)
            {
                // Cancel all pending requests
                std::lock_guard<std::mutex> lock(queue_mutex_);
                while (!pending_queue.empty())
                {
                    auto data = std::move(pending_queue.front());
                    pending_queue.pop();

                    Error error;
                    error.code = ErrorCode::InternalError;
                    error.message = "Request cancelled";

                    if (data->callback)
                    {
                        data->callback(data->request_id, error);
                    }
                    if (data->has_promise)
                    {
                        data->promise.set_value(error);
                    }
                }
            }

            queue_cv.notify_all();

            if (worker_thread.joinable())
            {
                worker_thread.join();
            }

            running = false;
        }

        void run_loop()
        {
            while (!stop_requested || !pending_queue.empty() || !active_transfers.empty())
            {
                // Move pending requests to active
                {
                    std::lock_guard<std::mutex> lock(queue_mutex_);
                    while (!pending_queue.empty() &&
                           active_transfers.size() < config.max_concurrent)
                    {
                        auto data = std::move(pending_queue.front());
                        pending_queue.pop();

                        CURL *easy = setup_easy_handle(data.get(), config);
                        if (easy)
                        {
                            curl_multi_add_handle(multi_handle, easy);
                            std::lock_guard<std::mutex> active_lock(active_mutex_);
                            active_transfers[easy] = std::move(data);
                        }
                        else
                        {
                            Error error;
                            error.code = ErrorCode::InternalError;
                            error.message = "Failed to create curl handle";

                            if (data->callback)
                            {
                                data->callback(data->request_id, error);
                            }
                            if (data->has_promise)
                            {
                                data->promise.set_value(error);
                            }
                        }
                    }
                }

                // Perform transfers
                int still_running = 0;
                curl_multi_perform(multi_handle, &still_running);

                // Check for completed transfers
                int msgs_left = 0;
                CURLMsg *msg = nullptr;
                while ((msg = curl_multi_info_read(multi_handle, &msgs_left)))
                {
                    if (msg->msg == CURLMSG_DONE)
                    {
                        CURL *easy = msg->easy_handle;
                        CURLcode result = msg->data.result;

                        std::unique_ptr<TransferData> data;
                        {
                            std::lock_guard<std::mutex> lock(active_mutex_);
                            auto it = active_transfers.find(easy);
                            if (it != active_transfers.end())
                            {
                                data = std::move(it->second);
                                active_transfers.erase(it);
                            }
                        }

                        if (data)
                        {
                            auto response_result = extract_response(easy, data.get(), result);

                            if (data->callback)
                            {
                                data->callback(data->request_id, response_result);
                            }
                            if (data->has_promise)
                            {
                                data->promise.set_value(std::move(response_result));
                            }

                            total_processed++;
                        }

                        curl_multi_remove_handle(multi_handle, easy);
                        curl_easy_cleanup(easy);
                    }
                }

                // Wait for activity or timeout
                if (still_running > 0)
                {
                    curl_multi_poll(multi_handle, nullptr, 0, config.poll_timeout_ms, nullptr);
                }
                else if (!stop_requested)
                {
                    // Wait for new requests
                    std::unique_lock<std::mutex> lock(queue_mutex_);
                    queue_cv.wait_for(lock,
                                      std::chrono::milliseconds(config.poll_timeout_ms),
                                      [this]
                                      {
                                          return stop_requested || !pending_queue.empty();
                                      });
                }
            }
        }

        size_t submit(const Request &request, RequestCallback callback, ProgressCallback progress)
        {
            auto data = std::make_unique<TransferData>();
            data->request_id = next_request_id++;
            data->request = request;
            data->callback = std::move(callback);
            data->progress = std::move(progress);

            size_t id = data->request_id;

            {
                std::lock_guard<std::mutex> lock(queue_mutex_);
                pending_queue.push(std::move(data));
            }

            queue_cv.notify_one();
            return id;
        }

        RequestHandle submit_async(const Request &request)
        {
            auto data = std::make_unique<TransferData>();
            data->request_id = next_request_id++;
            data->request = request;
            data->has_promise = true;

            RequestHandle handle;
            handle.id = data->request_id;
            handle.future = data->promise.get_future();

            {
                std::lock_guard<std::mutex> lock(queue_mutex_);
                pending_queue.push(std::move(data));
            }

            queue_cv.notify_one();
            return handle;
        }

        bool cancel(size_t request_id)
        {
            // Try to remove from pending queue
            {
                std::lock_guard<std::mutex> lock(queue_mutex_);
                std::queue<std::unique_ptr<TransferData>> new_queue;
                bool found = false;

                while (!pending_queue.empty())
                {
                    auto data = std::move(pending_queue.front());
                    pending_queue.pop();

                    if (data->request_id == request_id)
                    {
                        found = true;
                        Error error;
                        error.code = ErrorCode::InternalError;
                        error.message = "Request cancelled";

                        if (data->callback)
                        {
                            data->callback(data->request_id, error);
                        }
                        if (data->has_promise)
                        {
                            data->promise.set_value(error);
                        }
                    }
                    else
                    {
                        new_queue.push(std::move(data));
                    }
                }

                pending_queue = std::move(new_queue);
                if (found)
                {
                    return true;
                }
            }

            // Cannot cancel active transfers easily - would need to track and abort
            return false;
        }

        BatchResult execute_batch(const std::vector<Request> &requests)
        {
            BatchResult result;

            auto start_time = std::chrono::steady_clock::now();

            std::vector<RequestHandle> handles;
            handles.reserve(requests.size());

            // Submit all requests
            for (const auto &req : requests)
            {
                handles.push_back(submit_async(req));
            }

            // Wait for all results and collect them
            result.responses.reserve(requests.size());
            for (size_t i = 0; i < handles.size(); ++i)
            {
                auto response = handles[i].future.get();

                if (response.is_ok())
                {
                    result.successful++;
                }
                else
                {
                    result.failed++;
                }

                result.responses.push_back(std::move(response));
            }

            auto end_time = std::chrono::steady_clock::now();
            result.total_time_ms = std::chrono::duration<double, std::milli>(
                                       end_time - start_time)
                                       .count();

            return result;
        }

        size_t active_count() const
        {
            std::lock_guard<std::mutex> lock(active_mutex_);
            return active_transfers.size();
        }

        size_t pending_count() const
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            return pending_queue.size();
        }
    };

    EventLoop::EventLoop(EventLoopConfig config)
        : impl_(std::make_unique<Impl>(std::move(config))) {}

    EventLoop::~EventLoop() = default;

    EventLoop::EventLoop(EventLoop &&) noexcept = default;
    EventLoop &EventLoop::operator=(EventLoop &&) noexcept = default;

    void EventLoop::start()
    {
        impl_->start();
    }

    void EventLoop::stop(bool wait_for_pending)
    {
        impl_->stop(wait_for_pending);
    }

    bool EventLoop::is_running() const
    {
        return impl_->running;
    }

    size_t EventLoop::submit(const Request &request,
                             RequestCallback callback,
                             ProgressCallback progress)
    {
        return impl_->submit(request, std::move(callback), std::move(progress));
    }

    RequestHandle EventLoop::submit_async(const Request &request)
    {
        return impl_->submit_async(request);
    }

    bool EventLoop::cancel(size_t request_id)
    {
        return impl_->cancel(request_id);
    }

    BatchResult EventLoop::execute_batch(const std::vector<Request> &requests)
    {
        return impl_->execute_batch(requests);
    }

    size_t EventLoop::active_count() const
    {
        return impl_->active_count();
    }

    size_t EventLoop::pending_count() const
    {
        return impl_->pending_count();
    }

    size_t EventLoop::total_processed() const
    {
        return impl_->total_processed;
    }

    // ============================================================================
    // ThreadPool Implementation
    // ============================================================================

    struct ThreadPool::Impl
    {
        std::vector<std::thread> workers;
        std::queue<std::function<void()>> tasks;
        mutable std::mutex queue_mutex_;
        std::condition_variable condition;
        std::atomic<bool> stop{false};

        explicit Impl(size_t num_threads)
        {
            if (num_threads == 0)
            {
                num_threads = std::thread::hardware_concurrency();
                if (num_threads == 0)
                {
                    num_threads = 4; // Fallback
                }
            }

            workers.reserve(num_threads);
            for (size_t i = 0; i < num_threads; ++i)
            {
                workers.emplace_back([this]
                                     { worker_loop(); });
            }
        }

        ~Impl()
        {
            stop = true;
            condition.notify_all();

            for (auto &worker : workers)
            {
                if (worker.joinable())
                {
                    worker.join();
                }
            }
        }

        void worker_loop()
        {
            while (true)
            {
                std::function<void()> task;

                {
                    std::unique_lock<std::mutex> lock(queue_mutex_);
                    condition.wait(lock, [this]
                                   { return stop || !tasks.empty(); });

                    if (stop && tasks.empty())
                    {
                        return;
                    }

                    task = std::move(tasks.front());
                    tasks.pop();
                }

                task();
            }
        }

        void submit(std::function<void()> task)
        {
            {
                std::lock_guard<std::mutex> lock(queue_mutex_);
                tasks.push(std::move(task));
            }
            condition.notify_one();
        }

        size_t queue_size() const
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            return tasks.size();
        }
    };

    ThreadPool::ThreadPool(size_t num_threads)
        : impl_(std::make_unique<Impl>(num_threads)) {}

    ThreadPool::~ThreadPool() = default;

    void ThreadPool::submit_impl(std::function<void()> task)
    {
        impl_->submit(std::move(task));
    }

    BatchResult ThreadPool::execute_batch(const std::vector<Request> &requests)
    {
        BatchResult result;

        auto start_time = std::chrono::steady_clock::now();

        std::vector<std::future<Result<Response>>> futures;
        futures.reserve(requests.size());

        // Submit all requests to thread pool
        for (const auto &req : requests)
        {
            futures.push_back(submit([req]() -> Result<Response>
                                     {
                Client client;
                return client.send(req); }));
        }

        // Wait for all results and collect them
        result.responses.reserve(requests.size());
        for (size_t i = 0; i < futures.size(); ++i)
        {
            auto response = futures[i].get();

            if (response.is_ok())
            {
                result.successful++;
            }
            else
            {
                result.failed++;
            }

            result.responses.push_back(std::move(response));
        }

        auto end_time = std::chrono::steady_clock::now();
        result.total_time_ms = std::chrono::duration<double, std::milli>(
                                   end_time - start_time)
                                   .count();

        return result;
    }

    size_t ThreadPool::thread_count() const
    {
        return impl_->workers.size();
    }

    size_t ThreadPool::queue_size() const
    {
        return impl_->queue_size();
    }

} // namespace vayu::http

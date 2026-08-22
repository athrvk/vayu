// std::move_only_function - what thread_pool.hpp's queue wants in place of
// std::function, which forces every queued task to be copyable (phase 2.2 of
// #901). The move-only capture below is the whole point: it does not compile
// against std::function.
#include <functional>
#include <memory>

int main () {
    auto owned = std::make_unique<int> (3);
    std::move_only_function<int ()> task
        = [captured = std::move (owned)] { return *captured; };
    return task () == 3 ? 0 : 1;
}

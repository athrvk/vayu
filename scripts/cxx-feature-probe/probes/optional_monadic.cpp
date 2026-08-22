// Monadic std::optional (and_then / transform / or_else) - adopted in touched
// code under phase 2.3 of #901, never as a sweep of the ~426 existing sites.
#include <optional>

int main () {
    const std::optional<int> value{2};
    const auto result
        = value.and_then ([] (int x) { return std::optional<int>{x * 2}; })
              .transform ([] (int x) { return x + 1; })
              .or_else ([] { return std::optional<int>{0}; });
    return result.value_or (0) == 5 ? 0 : 1;
}

// std::ranges::to - the piece that makes a ranges pipeline terminate in a
// container. A declared non-goal of #901 on its own; probed because it is what
// a "ranges rewrite" would need if that decision is ever revisited.
#include <ranges>
#include <vector>

int main () {
    const auto values = std::views::iota (0, 4) | std::ranges::to<std::vector<int>> ();
    return values.size () == 4 ? 0 : 1;
}

// std::flat_map - dropped from #901's plan as years from the floor. Probed so
// that "years away" stays a measurement rather than a memory.
#include <flat_map>

int main () {
    std::flat_map<int, int> map;
    map.insert ({1, 2});
    return map.at (1) == 2 ? 0 : 1;
}

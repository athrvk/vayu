// Deducing this (explicit object parameter) - a language feature, so the
// answer is the compiler's alone, not the standard library's.
struct Counter {
    int n = 0;
    [[nodiscard]] int value (this const Counter& self) { return self.n; }
};

int main () {
    const Counter counter{5};
    return counter.value () == 5 ? 0 : 1;
}

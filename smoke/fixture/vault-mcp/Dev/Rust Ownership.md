# Rust Ownership

Ownership rules: every value has exactly one owner, and when the owner goes
out of scope the value is dropped. Borrowing lets references access data
without taking ownership — one mutable borrow XOR many immutable ones.

The borrow checker enforces these rules at compile time, which eliminates
data races in safe code. `Rc<RefCell<T>>` allows shared mutation in single
threaded code; `Arc<Mutex<T>>` is the threaded equivalent.

# Kotlin Coroutines

Coroutines are lightweight concurrency primitives. A `launch` block returns
a `Job`, while `async` returns a `Deferred` that you await for a result.

## Structured Concurrency

Structured concurrency ties child coroutine lifetimes to a parent scope.
When the parent scope is cancelled, all children are cancelled too.

```kotlin
suspend fun fetch(): String = coroutineScope {
    async { apiCall() }.await()
}
```

Use `SupervisorJob` when one failing child should not cancel its siblings.

# TypeScript Type Guards

A type guard narrows a union type inside a conditional block. The simplest
form is a `typeof` or `instanceof` check; for object shapes write a custom
predicate: `function isFish(pet: Pet): pet is Fish`.

`satisfies` verifies that an object literal conforms to a type without
widening the inferred type — useful for config objects.

Exhaustiveness: adding a `default` branch that assigns the union to `never`
makes the compiler flag missing cases at compile time.

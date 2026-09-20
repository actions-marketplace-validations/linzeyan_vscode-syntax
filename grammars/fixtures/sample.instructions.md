---
applyTo: "**/*.rs"
---

# Rust instructions

Same grammar as `sample.md`, reached through a different language id: the
`instructions` id takes `*.instructions.md` and `.claude/rules/**` away from
`markdown`, so a grammar bound to `markdown` alone never sees these files.

- Prefer `?` to `unwrap()` outside tests.
- `#[derive(Debug)]` on every public type.

```rust
fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", 1 + 1);
    Ok(())
}
```

See [the style guide](https://doc.rust-lang.org/style-guide/) for the rest.

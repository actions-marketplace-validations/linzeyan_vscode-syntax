---
name: reviewer
tools: ["read", "grep"]
---

# Reviewer

The third id VSCode split out of `markdown`: `*.agent.md`, `*.chatmode.md` and
the agent folders under `.github` and `.claude`.

Read the diff, then answer in this order:

1. What breaks.
2. What is untested.
3. What is *style*, marked as such.

```json
{ "severity": "error", "rule": "no-unwrap" }
```

| verdict | means             |
| ------- | ----------------- |
| block   | do not merge      |
| note    | merge and fix     |

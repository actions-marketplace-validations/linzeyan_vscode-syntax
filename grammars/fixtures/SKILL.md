---
name: release-check
description: What to verify before cutting a release.
---

# Release check

VSCode 1.120 gave `SKILL.md` its own language id, and an extension that only
claims `markdown` stops working in exactly the files people edit as markdown.
This fixture exists so the comparison can see that poly's takeover of the id
still lands on the markdown grammar.

1. `make gates` is green.
2. The version strings agree — **all** of them.
3. `CHANGELOG.md` names the change, not the commit.

```sh
make bump VERSION=0.12.2 && make gates
```

> A release that skips the second step is one nobody can bisect.

- [ ] tagged
- [x] notes written

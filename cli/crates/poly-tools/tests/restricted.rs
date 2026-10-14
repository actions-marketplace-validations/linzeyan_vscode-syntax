//! Restricted Mode is process-wide and one-way, so it gets a test process of
//! its own: switched on inside the crate's unit tests it would take every tool
//! away from the tests running beside it.

use poly_tools::{project, resolve, Resolved};

/// What an untrusted folder can choose for poly to run is still found before
/// `restrict`, and nothing of it after -- the first half is what lets the
/// second half fail.
#[test]
fn a_restricted_poly_finds_nothing_to_run() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    // A project-local prettier, the kind poly prefers to its own engine.
    let bin = root.join("node_modules").join(".bin");
    std::fs::create_dir_all(&bin).unwrap();
    let prettier = if cfg!(windows) {
        "prettier.cmd"
    } else {
        "prettier"
    };
    std::fs::write(bin.join(prettier), "").unwrap();
    std::fs::write(root.join(".prettierrc"), "{}").unwrap();
    // And a `[tools]` path into the folder itself.
    std::fs::write(root.join("sc"), "").unwrap();
    std::fs::write(root.join("poly.toml"), "[tools]\nshellcheck = \"./sc\"\n").unwrap();
    let config = poly_core::Config::discover(&root).unwrap();
    // Something every machine has on PATH.
    let shell = if cfg!(windows) { "cmd" } else { "sh" };

    assert!(project::prettier(&root).is_some());
    assert!(matches!(
        resolve("shellcheck", &config, true),
        Resolved::Pinned(_)
    ));
    assert!(poly_tools::find_on_path(shell).is_some());

    poly_tools::restrict();
    assert!(project::prettier(&root).is_none());
    assert_eq!(
        resolve("shellcheck", &config, true),
        Resolved::Missing(poly_tools::RESTRICTED_REASON.to_string())
    );
    assert!(poly_tools::find_on_path(shell).is_none());
    // Refused before the cache or the network is looked at, so the error is
    // the reason and not a failed fetch.
    let refused = poly_tools::schema("https://example.invalid/x.json").unwrap_err();
    assert!(
        refused.to_string().contains(poly_tools::RESTRICTED_REASON),
        "{refused}"
    );
}

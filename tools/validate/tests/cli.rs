// Synthetic executable fixtures exercise the compiled CLI and real process/exit/stdio semantics.
// Windows shell selection has a unit check; these POSIX fixtures require a Unix host.
#![cfg(unix)]
use linky_validate::CHECKS;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "linky rust validation {} {}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir_all(path.join("tools/validate")).unwrap();
        fs::write(path.join("package.json"), "{}").unwrap();
        fs::write(path.join("tools/validate/Cargo.toml"), "").unwrap();
        for program in ["npm", "cargo", "bash"] {
            let script = path.join(program);
            fs::write(&script, "#!/bin/sh\nprintf '%s|%s\\n' \"${0##*/}\" \"$*\" >> \"$LINKY_FIXTURE_TRACE\"\nprintf 'synthetic check output\\n'\nif [ \"${0##*/}|$*\" = \"$LINKY_FIXTURE_FAIL\" ]; then exit 7; fi\n").unwrap();
            fs::set_permissions(script, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(path)
    }
    fn run(&self, fail: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_linky-validate"))
            .current_dir(&self.0)
            .env("PATH", &self.0)
            .env("LINKY_FIXTURE_TRACE", self.0.join("trace"))
            .env("LINKY_FIXTURE_FAIL", fail)
            .args(args)
            .output()
            .unwrap()
    }
    fn trace(&self) -> Vec<String> {
        fs::read_to_string(self.0.join("trace"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.replace('|', " "))
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn compiled_cli_runs_every_real_child_and_inherits_stdout_in_a_path_with_spaces() {
    let fixture = Fixture::new();
    let output = fixture.run("", &[]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(fixture.trace(), CHECKS);
    let text = String::from_utf8(output.stdout).unwrap();
    assert_eq!(text.matches("synthetic check output").count(), CHECKS.len());
    assert!(text.ends_with("All checks passed.\n"));
}

#[test]
fn a_real_failed_test_still_runs_deploy_audit_and_rust_checks_and_exits_one() {
    let fixture = Fixture::new();
    let output = fixture.run("npm|test", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(fixture.trace(), CHECKS);
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("FAIL  npm test  ("));
    assert!(text.contains(", exit 7)"));
    assert!(text.contains("PASS  npm audit --audit-level=low"));
}

#[test]
fn a_missing_tool_fails_closed_but_still_runs_the_available_tools() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.0.join("npm")).unwrap();
    let output = fixture.run("", &[]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        fixture.trace(),
        CHECKS
            .iter()
            .filter(|command| !command.starts_with("npm "))
            .copied()
            .collect::<Vec<_>>()
    );
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains(", exit 127)")
    );
}

#[test]
fn listing_and_help_do_not_run_checks_and_unknown_arguments_cannot_be_shell_code() {
    let fixture = Fixture::new();
    let listed = fixture.run("", &["--list"]);
    assert!(listed.status.success());
    assert_eq!(
        String::from_utf8(listed.stdout).unwrap(),
        format!("{}\n", CHECKS.join("\n"))
    );
    assert!(fixture.run("", &["--help"]).status.success());
    assert_eq!(
        fixture.run("", &["; touch injected"]).status.code(),
        Some(2)
    );
    assert!(fixture.trace().is_empty());
    assert!(!fixture.0.join("injected").exists());
}

#[test]
fn wrong_working_directory_is_an_error_without_launching_any_check() {
    let fixture = Fixture::new();
    fs::remove_file(fixture.0.join("package.json")).unwrap();
    assert_eq!(fixture.run("", &[]).status.code(), Some(2));
    assert!(fixture.trace().is_empty());
}

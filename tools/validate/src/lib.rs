use std::io::{self, Write};
use std::process::Command;
use std::time::{Duration, Instant};

/// Keep the original Node validator's gates and order; validate the Rust port as well.
pub const CHECKS: &[&str] = &[
    "npm run build",
    "npm run check:workers",
    "npm test",
    "bash tests/deploy.test.sh",
    "npm audit --audit-level=low",
    "cargo test --locked --manifest-path tools/validate/Cargo.toml",
    "cargo clippy --locked --manifest-path tools/validate/Cargo.toml --all-targets -- -D warnings",
    "cargo fmt --manifest-path tools/validate/Cargo.toml -- --check",
];

pub const NOT_RUN: &str = "Not run locally: Secret scan (gitleaks, CI job \"Secret scan\") and production container checks (CI job \"Production container\", VERIFICATION 2.5).";

#[derive(Debug)]
pub struct CheckResult {
    pub command: &'static str,
    pub status: i32,
    pub elapsed: Duration,
}

pub fn shell_spec(windows: bool) -> (&'static str, &'static [&'static str]) {
    if windows {
        // Fixed command strings only. cmd resolves npm.cmd and Git Bash from PATH.
        ("cmd", &["/d", "/s", "/c"])
    } else {
        ("/bin/sh", &["-c"])
    }
}

pub fn run_check(command: &str) -> io::Result<i32> {
    let (shell, args) = shell_spec(cfg!(windows));
    // status inherits the caller's cwd, environment and stdio, like spawnSync(shell: true).
    // No member message, CLI argument or environment value becomes shell source.
    Command::new(shell)
        .args(args)
        .arg(command)
        .status()
        .map(|status| status.code().unwrap_or(1))
}

/// Continue after every check failure, preserving each exit and the complete PASS/FAIL summary.
pub fn validate(
    mut run: impl FnMut(&str) -> io::Result<i32>,
    output: &mut impl Write,
) -> io::Result<Vec<CheckResult>> {
    let mut results = Vec::with_capacity(CHECKS.len());
    for &command in CHECKS {
        writeln!(output, "\n> {command}")?;
        output.flush()?;
        let started = Instant::now();
        let status = match run(command) {
            Ok(status) => status,
            Err(error) => {
                writeln!(output, "Could not start check: {error}")?;
                1
            }
        };
        results.push(CheckResult {
            command,
            status,
            elapsed: started.elapsed(),
        });
    }
    writeln!(output, "\nValidation summary")?;
    for result in &results {
        let verdict = if result.status == 0 { "PASS" } else { "FAIL" };
        let exit = if result.status == 0 {
            String::new()
        } else {
            format!(", exit {}", result.status)
        };
        writeln!(
            output,
            "{verdict}  {}  ({:.1}s{exit})",
            result.command,
            result.elapsed.as_secs_f64()
        )?;
    }
    writeln!(output, "{NOT_RUN}")?;
    writeln!(
        output,
        "{}",
        if passed(&results) {
            "All checks passed."
        } else {
            "One or more checks failed."
        }
    )?;
    Ok(results)
}

pub fn passed(results: &[CheckResult]) -> bool {
    results.len() == CHECKS.len() && results.iter().all(|result| result.status == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_original_gates_and_order() {
        assert_eq!(
            &CHECKS[..5],
            [
                "npm run build",
                "npm run check:workers",
                "npm test",
                "bash tests/deploy.test.sh",
                "npm audit --audit-level=low"
            ]
        );
    }

    #[test]
    fn every_failure_position_continues_and_reports_its_actual_exit() {
        for failing in 0..CHECKS.len() {
            let mut ran = Vec::new();
            let mut output = Vec::new();
            let results = validate(
                |command| {
                    ran.push(command.to_owned());
                    Ok(if command == CHECKS[failing] { 7 } else { 0 })
                },
                &mut output,
            )
            .unwrap();
            assert_eq!(ran, CHECKS);
            assert!(!passed(&results));
            assert_eq!(results[failing].status, 7);
            let text = String::from_utf8(output).unwrap();
            assert!(text.contains(&format!("FAIL  {}  (", CHECKS[failing])));
            assert!(text.contains(", exit 7)"));
            assert_eq!(text.matches("PASS  ").count(), CHECKS.len() - 1);
            assert!(text.ends_with("One or more checks failed.\n"));
        }
    }

    #[test]
    fn success_requires_every_gate_and_never_promises_container_or_live_checks() {
        let mut output = Vec::new();
        let results = validate(|_| Ok(0), &mut output).unwrap();
        assert!(passed(&results));
        assert!(!passed(&results[..results.len() - 1]));
        assert!(!passed(&[]));
        let text = String::from_utf8(output).unwrap();
        assert_eq!(text.matches("PASS  ").count(), CHECKS.len());
        assert!(text.contains(NOT_RUN));
        assert!(text.ends_with("All checks passed.\n"));
    }

    #[test]
    fn a_spawn_error_fails_closed_and_does_not_skip_later_gates() {
        let mut output = Vec::new();
        let mut count = 0;
        let results = validate(
            |_| {
                count += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(count, CHECKS.len());
        assert!(results.iter().all(|result| result.status == 1));
        assert!(!passed(&results));
    }

    #[test]
    fn windows_and_unix_keep_the_supported_shell_resolution() {
        assert_eq!(shell_spec(false), ("/bin/sh", &["-c"][..]));
        assert_eq!(shell_spec(true), ("cmd", &["/d", "/s", "/c"][..]));
    }

    #[test]
    fn a_broken_output_stream_is_an_error_not_a_green_validation() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::from(io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(validate(|_| Ok(0), &mut Broken).is_err());
    }
}

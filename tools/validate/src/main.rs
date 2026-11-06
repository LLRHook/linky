use linky_validate::{CHECKS, passed, run_check, validate};
use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--list" {
        return if writeln!(io::stdout().lock(), "{}", CHECKS.join("\n")).is_ok() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!(
            "Usage: npm run validate [-- --list|--help]\nRun from the Linky repository root. Every local CI check runs even after a failure."
        );
        return ExitCode::SUCCESS;
    }
    if !args.is_empty() {
        eprintln!("Unknown arguments. Use npm run validate -- --help.");
        return ExitCode::from(2);
    }
    if !Path::new("package.json").is_file() || !Path::new("tools/validate/Cargo.toml").is_file() {
        eprintln!("Run validation from the Linky repository root.");
        return ExitCode::from(2);
    }
    match validate(run_check, &mut io::stdout().lock()) {
        Ok(results) if passed(&results) => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("Could not report validation: {error}");
            ExitCode::FAILURE
        }
    }
}

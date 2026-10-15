//! Warn when the Windows logon entry names an `ai-memory.exe` that is not
//! on disk.
//!
//! Bitdefender's Advanced Threat Control quarantines the unsigned binary
//! under `%LOCALAPPDATA%` and leaves the `Run` value in place (#1280). The
//! server then never starts, and every hook keeps calling a path that is
//! gone, with no error from ai-memory. `doctor` and `status` are the
//! commands an operator already runs, so they are where that absence shows.
//!
//! On Windows the value is read through the registry API. Spawning `reg.exe`
//! against `HKCU\...\CurrentVersion\Run` is itself one of the signals that
//! engine scores, so this check does not. The read is injected: tests supply
//! a command line and a path that is not on disk, with no Windows machine and
//! no real registry.

use std::path::Path;

use serde::Serialize;

/// Classification `doctor` and `status` share, so a script can match one token.
pub(crate) const CLASSIFICATION: &str = "logon_binary_missing";

/// The subcommand a `setup` logon entry ends with.
const SERVICE_HOST: &str = "service-host";

/// The `Run` value names an `ai-memory.exe` that is not on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct MissingLogonBinary {
    /// [`CLASSIFICATION`].
    pub(crate) classification: &'static str,
    /// The executable path from the logon command, quotes removed.
    pub(crate) executable: String,
    /// One sentence an operator can act on.
    pub(crate) detail: String,
}

/// The `ai-memory` value under `HKCU\...\CurrentVersion\Run`.
pub(crate) trait RunValueSource {
    /// The value's data, or `None` when it is absent or cannot be read.
    fn run_value(&self) -> Option<String>;
}

/// A fixed value, so tests never open a registry.
#[cfg(test)]
pub(crate) struct FixedRunValue(pub(crate) Option<String>);

#[cfg(test)]
impl RunValueSource for FixedRunValue {
    fn run_value(&self) -> Option<String> {
        self.0.clone()
    }
}

/// The registry of the signed-in user. On anything but Windows there is no
/// such key, and the check stays quiet.
pub(crate) struct LiveRunValue;

impl RunValueSource for LiveRunValue {
    fn run_value(&self) -> Option<String> {
        live_run_value()
    }
}

/// The logon entry's missing binary, if the value is one `setup` would write
/// and `is_file` says the executable is gone.
///
/// Any other value under the name is someone else's and is left alone. A
/// binary that is present is not a quarantine.
pub(crate) fn inspect(
    source: &dyn RunValueSource,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<MissingLogonBinary> {
    let value = source.run_value()?;
    let executable = setup_logon_executable(&value)?;
    if is_file(Path::new(&executable)) {
        return None;
    }
    let detail = format!(
        "the Windows logon entry points at {executable}, which does not exist; \
         it may have been quarantined by antivirus"
    );
    Some(MissingLogonBinary {
        classification: CLASSIFICATION,
        executable,
        detail,
    })
}

/// [`inspect`] against the signed-in user's registry and the real filesystem.
pub(crate) fn inspect_live() -> Option<MissingLogonBinary> {
    inspect(&LiveRunValue, &Path::is_file)
}

/// The human warning `doctor` and `status` print. The JSON form is
/// [`MissingLogonBinary`] itself.
pub(crate) fn render_human(problem: &MissingLogonBinary) -> String {
    format!(
        "⚠ {}: {}\n  \
         Hooks keep calling that path, so capture stops until the binary is restored.\n  \
         Run `ai-memory setup --no-service` and start the server yourself, or see \
         docs/windows.md (Antivirus / EDR).",
        problem.classification, problem.detail
    )
}

/// The executable a `setup` logon entry names.
///
/// The shape is a quoted `ai-memory.exe` whose arguments end in
/// `service-host`, with no `&` or `|`. That is what the Windows logon entry
/// holds; a hand-written value under the same name does not match.
fn setup_logon_executable(data: &str) -> Option<String> {
    let rest = data.strip_prefix('"')?;
    let (program, args) = rest.split_once('"')?;
    // A backslash escapes the closing quote. An odd run of them means the
    // argument continues past the character this split treated as the end.
    let trailing = program.len() - program.trim_end_matches('\\').len();
    if trailing % 2 != 0 {
        return None;
    }
    let program = program[..program.len() - trailing / 2].to_owned();
    let file = program.rsplit(['\\', '/']).next().unwrap_or("");
    if !file.eq_ignore_ascii_case("ai-memory.exe") {
        return None;
    }
    let args = args.trim();
    if args.contains('&') || args.contains('|') {
        return None;
    }
    (args.split_whitespace().next_back() == Some(SERVICE_HOST)).then_some(program)
}

/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ai-memory`, and only
/// when it is a `REG_SZ`. An expandable string under the same name is not
/// one `setup` writes.
#[cfg(windows)]
fn live_run_value() -> Option<String> {
    const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_VALUE: &str = "ai-memory";
    let key = windows_registry::CURRENT_USER.open(RUN_SUBKEY).ok()?;
    match key.get_type(RUN_VALUE).ok()? {
        windows_registry::Type::String => key.get_string(RUN_VALUE).ok(),
        _ => None,
    }
}

#[cfg(not(windows))]
fn live_run_value() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A logon command of the shape `setup` writes, aimed at `executable`.
    fn logon_command(executable: &str) -> String {
        format!(
            "\"{executable}\" --data-dir \"C:\\Users\\me\\AppData\\Local\\ai-memory\" \
             --config \"C:\\Users\\me\\AppData\\Local\\ai-memory\\config.toml\" service-host"
        )
    }

    #[test]
    fn a_missing_logon_binary_is_reported_and_a_present_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("Programs").join("ai-memory.exe");
        assert!(
            !missing.exists(),
            "the quarantine stand-in must not be on disk"
        );
        let problem = inspect(
            &FixedRunValue(Some(logon_command(&missing.display().to_string()))),
            &Path::is_file,
        )
        .expect("a logon entry whose executable is gone");
        assert_eq!(problem.classification, CLASSIFICATION);
        assert_eq!(problem.executable, missing.display().to_string());
        assert!(
            problem.detail.contains("quarantined by antivirus"),
            "{}",
            problem.detail
        );
        assert!(
            problem.detail.contains(&problem.executable),
            "{}",
            problem.detail
        );
        let human = render_human(&problem);
        assert!(human.contains("logon_binary_missing"), "{human}");
        assert!(human.contains("setup --no-service"), "{human}");
        assert!(human.contains("Antivirus / EDR"), "{human}");

        let present = dir.path().join("ai-memory.exe");
        std::fs::write(&present, b"").unwrap();
        assert!(present.is_file());
        assert!(
            inspect(
                &FixedRunValue(Some(logon_command(&present.display().to_string()))),
                &Path::is_file,
            )
            .is_none(),
            "a binary that is on disk is not a quarantine"
        );
    }

    /// The field incident's path: an unsigned copy under `%LOCALAPPDATA%`,
    /// including one with spaces, and the older verbatim `\\?\` spelling.
    #[test]
    fn a_localappdata_logon_entry_whose_file_is_gone_names_that_file() {
        let cases = [
            r#""C:\Users\ai-memory-quarantine-test\AppData\Local\Programs\ai-memory\ai-memory.exe" --data-dir "C:\Users\ai-memory-quarantine-test\AppData\Local\ai-memory" --config "C:\Users\ai-memory-quarantine-test\AppData\Local\ai-memory\config.toml" service-host"#,
            r#""C:\Program Files\ai memory\ai-memory.exe" --data-dir "D:\data" --config "D:\data\config.toml" service-host"#,
            r#""\\?\C:\Users\ai-memory-quarantine-test\AppData\Local\ai-memory\ai-memory.exe" --data-dir "C:\d" --config "C:\d\config.toml" service-host"#,
            r#""C:\bin\AI-MEMORY.EXE" service-host"#,
        ];
        for command in cases {
            let executable = command
                .strip_prefix('"')
                .and_then(|rest| rest.split_once('"'))
                .map(|(program, _)| program)
                .unwrap();
            assert!(
                !Path::new(executable).is_file(),
                "{executable} must not be on disk for this test"
            );
            let problem = inspect(&FixedRunValue(Some(command.to_owned())), &Path::is_file)
                .unwrap_or_else(|| panic!("expected a hint for {command}"));
            assert_eq!(problem.executable, executable);
            assert!(
                problem.detail.contains("does not exist"),
                "{}",
                problem.detail
            );
        }
    }

    #[test]
    fn other_run_values_are_not_a_quarantine_hint() {
        let cases = [
            None,
            Some(r"C:\x\ai-memory.exe service-host".to_owned()),
            Some(r#""C:\x\other.exe" service-host"#.to_owned()),
            Some(r#""C:\x\ai-memory.exe" serve"#.to_owned()),
            Some(r#""C:\x\ai-memory.exe" service-host & calc"#.to_owned()),
            Some(r#""C:\x\ai-memory.exe" x | y service-host"#.to_owned()),
            Some(r#""C:\x\not-ai-memory.exe" service-host"#.to_owned()),
        ];
        for value in cases {
            let shown = value.clone();
            assert!(
                inspect(&FixedRunValue(value), &Path::is_file).is_none(),
                "not a setup logon entry: {shown:?}"
            );
        }
    }

    /// Linux and macOS have no per-user `Run` key. The live check must not
    /// invent one; the Windows read is the registry API, covered by the
    /// injected value above.
    #[cfg(not(windows))]
    #[test]
    fn the_live_check_is_quiet_off_windows() {
        assert!(inspect_live().is_none());
    }
}

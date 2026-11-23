//! macOS session storage compatible with the released Node backend.

use crate::ServiceError;

pub(crate) fn available() -> bool {
    cfg!(target_os = "macos")
        && !cfg!(test)
        && std::env::var("HG_DISABLE_KEYCHAIN").as_deref() != Ok("1")
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    const SERVICE: &str = "com.hgdrama.nsh.session";
    const ACCOUNT: &str = "default";

    fn failed(action: &str) -> ServiceError {
        ServiceError::new("KEYCHAIN_ERROR", format!("无法{action}系统钥匙串中的会话"))
    }

    fn access(operation: &str) -> Command {
        let mut command = Command::new("/usr/bin/security");
        command.args([operation, "-s", SERVICE, "-a", ACCOUNT]);
        command
    }

    fn missing(output: &std::process::Output) -> bool {
        String::from_utf8_lossy(&output.stderr).contains("could not be found in the keychain")
    }

    pub(crate) fn read() -> Result<Option<String>, ServiceError> {
        if !available() {
            return Ok(None);
        }
        let output = access("find-generic-password")
            .arg("-w")
            .output()
            .map_err(|_| failed("读取"))?;
        if !output.status.success() {
            return if missing(&output) {
                Ok(None)
            } else {
                Err(failed("读取"))
            };
        }
        let encoded = String::from_utf8_lossy(&output.stdout);
        let bytes = STANDARD
            .decode(encoded.trim())
            .map_err(|_| failed("解析"))?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| failed("解析"))
    }

    pub(crate) fn save(value: &str) -> Result<bool, ServiceError> {
        if !available() {
            return Ok(false);
        }
        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| failed("保存"))?;
        let encoded = STANDARD.encode(value.as_bytes());
        let mut input = child.stdin.take().expect("piped input");
        let write = writeln!(
            &mut input,
            "add-generic-password -U -a {ACCOUNT} -s {SERVICE} -w \"{encoded}\""
        );
        drop(input);
        let output = child.wait_with_output().map_err(|_| failed("保存"))?;
        write.map_err(|_| failed("保存"))?;
        if !output.status.success() || output.stderr.windows(9).any(|part| part == b"Keychain:") {
            return Err(failed("保存"));
        }
        Ok(true)
    }

    pub(crate) fn delete() -> Result<(), ServiceError> {
        if !available() {
            return Ok(());
        }
        let output = access("delete-generic-password")
            .output()
            .map_err(|_| failed("清除"))?;
        if output.status.success() || missing(&output) {
            Ok(())
        } else {
            Err(failed("清除"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub(crate) fn read() -> Result<Option<String>, ServiceError> {
        Ok(None)
    }
    pub(crate) fn save(_: &str) -> Result<bool, ServiceError> {
        Ok(false)
    }
    pub(crate) fn delete() -> Result<(), ServiceError> {
        Ok(())
    }
}

pub(crate) use platform::{delete, read, save};

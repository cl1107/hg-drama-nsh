use nsh_core::prelude::*;

/// Starts the native companion service for the app window.
#[module]
struct LocalService;

#[module]
impl LocalService {
    /// Starts the in-process loopback service and returns this app instance's connection.
    pub fn connection() -> Result<ServiceConnection, String> {
        server::connection()
    }
}

/// Runtime connection for TSX and the native video player.
#[derive(Clone, JsObject)]
pub struct ServiceConnection {
    pub base_url: String,
    pub token: String,
}

#[native_module("hg-drama/native")]
fn native(registry: &mut Registry) {
    registry.module::<LocalService>();
}

#[derive(Clone, Debug)]
pub(crate) struct ServiceError {
    code: &'static str,
    message: String,
}

impl ServiceError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fmt.write_str(&self.message)
    }
}

impl std::error::Error for ServiceError {}

mod auth;
mod catalog;
mod credentials;
mod danmaku;
mod downloads;
mod media;
mod server;
mod transport;
mod upstream;

pub(crate) use upstream::metadata_protocol;

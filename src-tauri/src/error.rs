use std::fmt::{self, Display};

/// A flat, display-oriented error. Every failure that crosses the IPC boundary
/// becomes a plain string, which is all the frontend can act on anyway.
#[derive(Debug, Clone)]
pub struct AppError(pub String);

impl AppError {
    pub fn new(msg: impl Display) -> Self {
        AppError(msg.to_string())
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

/// `map_err(err)` adapter for any foreign error type.
pub fn err<E: Display>(e: E) -> AppError {
    AppError(e.to_string())
}

macro_rules! from_display {
    ($($t:ty),* $(,)?) => {
        $(impl From<$t> for AppError {
            fn from(e: $t) -> Self { AppError(e.to_string()) }
        })*
    };
}

from_display!(
    std::io::Error,
    std::num::ParseIntError,
    serde_json::Error,
    russh::Error,
    russh::keys::Error,
    russh_sftp::client::error::Error,
    serialport::Error,
);

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError(e)
    }
}

impl From<&str> for AppError {
    fn from(e: &str) -> Self {
        AppError(e.to_string())
    }
}

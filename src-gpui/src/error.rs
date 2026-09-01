use std::fmt::{self, Display};

#[derive(Debug, Clone)]
pub struct AppError(pub String);

impl AppError {
    pub fn new(message: impl Display) -> Self {
        Self(message.to_string())
    }
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

pub type Result<T> = std::result::Result<T, AppError>;

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<String> for AppError {
    fn from(error: String) -> Self {
        Self(error)
    }
}

impl From<&str> for AppError {
    fn from(error: &str) -> Self {
        Self(error.to_string())
    }
}

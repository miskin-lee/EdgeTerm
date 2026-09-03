//! Interactive authentication challenges.
//!
//! Some servers finish authenticating a session by asking questions — a
//! one-time code, a push confirmation, a menu choice — through SSH's
//! `keyboard-interactive` method (RFC 4256). Those answers are not in the
//! profile: they exist only in the moment, so the connecting task has to stop
//! and ask. A challenge travels to the frontend as a `session:auth-prompt`
//! event and the answer comes back through the `answer_auth_prompt` command;
//! this module is where the two meet.

use std::collections::HashMap;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::{AppError, Result};
use crate::model::{AuthPrompt, AuthPromptField};

pub const EVENT_AUTH_PROMPT: &str = "session:auth-prompt";

/// How long one challenge waits for an answer. Long enough to reach for a
/// phone, short enough that a window which will never answer — it was closed
/// or reloaded with the dialog on screen — cannot hold a half-open connection
/// open indefinitely.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(180);

/// One round of questions, as the connecting task poses it. The session and
/// the challenge id are added by [`AuthPrompter::ask`].
pub struct Challenge {
    /// `host:port` of the hop asking, which is a jump host for every hop but
    /// the last one.
    pub address: String,
    pub username: String,
    /// Server-supplied title for the round; usually empty.
    pub name: String,
    /// Server-supplied text shown above the questions; usually empty.
    pub instructions: String,
    pub prompts: Vec<AuthPromptField>,
}

/// The challenges waiting for an answer, keyed by the id carried in the event.
#[derive(Default)]
pub struct AuthPrompts {
    pending: Mutex<HashMap<String, oneshot::Sender<Option<Vec<String>>>>>,
}

impl AuthPrompts {
    /// Registers a challenge, returning its id and the channel its answer
    /// will arrive on.
    fn register(&self) -> (String, oneshot::Receiver<Option<Vec<String>>>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        (id, rx)
    }

    fn forget(&self, id: &str) {
        self.pending.lock().remove(id);
    }

    /// Hands the user's answers to the task waiting on `id`; `None` cancels
    /// the attempt. Every challenge is answered at most once, so an id that
    /// is no longer waiting is an error the caller can ignore.
    pub fn answer(&self, id: &str, responses: Option<Vec<String>>) -> Result<()> {
        let waiting = self.pending.lock().remove(id).ok_or_else(|| {
            AppError::new("this authentication prompt is no longer waiting for an answer")
        })?;
        // The connecting task can give up between the two locks; then there
        // is nobody left to tell, and nothing to do about it.
        let _ = waiting.send(responses);
        Ok(())
    }
}

/// Where a keyboard-interactive challenge goes for an answer. The connecting
/// task holds one for as long as the handshake lasts.
pub struct AuthPrompter<'a> {
    session_id: &'a str,
    sink: Sink<'a>,
}

enum Sink<'a> {
    /// Ask the user: emit the challenge and wait for `answer_auth_prompt`.
    Ui {
        app: &'a AppHandle,
        prompts: &'a AuthPrompts,
    },
    /// Answer from a script instead of a user (tests only).
    #[cfg(test)]
    Canned(&'a Mutex<CannedAnswers>),
}

impl<'a> AuthPrompter<'a> {
    pub fn ui(app: &'a AppHandle, prompts: &'a AuthPrompts, session_id: &'a str) -> Self {
        Self {
            session_id,
            sink: Sink::Ui { app, prompts },
        }
    }

    #[cfg(test)]
    pub fn canned(answers: &'a Mutex<CannedAnswers>) -> Self {
        Self {
            session_id: "test-session",
            sink: Sink::Canned(answers),
        }
    }

    /// Puts one round of questions to the user and waits. `None` means the
    /// user cancelled and the connection attempt should stop.
    pub async fn ask(&self, challenge: Challenge) -> Result<Option<Vec<String>>> {
        match self.sink {
            Sink::Ui { app, prompts } => {
                let (id, answer) = prompts.register();
                let prompt = AuthPrompt {
                    id: id.clone(),
                    session_id: self.session_id.to_string(),
                    address: challenge.address,
                    username: challenge.username,
                    name: challenge.name,
                    instructions: challenge.instructions,
                    prompts: challenge.prompts,
                };
                if app.emit(EVENT_AUTH_PROMPT, &prompt).is_err() {
                    prompts.forget(&id);
                    return Err(AppError::new(
                        "cannot ask for the server's verification response",
                    ));
                }
                match tokio::time::timeout(ANSWER_TIMEOUT, answer).await {
                    Ok(Ok(responses)) => Ok(responses),
                    // The waiting end was dropped without an answer.
                    Ok(Err(_)) => Ok(None),
                    Err(_) => {
                        prompts.forget(&id);
                        Err(AppError::new(
                            "timed out waiting for the answer to the server's authentication prompt",
                        ))
                    }
                }
            }
            #[cfg(test)]
            Sink::Canned(answers) => Ok(answers.lock().next(challenge)),
        }
    }
}

/// A scripted user: the answers each round gets, and a record of what was
/// asked so a test can check the questions reached the dialog intact.
#[cfg(test)]
#[derive(Default)]
pub struct CannedAnswers {
    answers: std::collections::VecDeque<Vec<String>>,
    asked: Vec<Challenge>,
}

#[cfg(test)]
impl CannedAnswers {
    pub fn new<I: IntoIterator<Item = Vec<String>>>(answers: I) -> Self {
        Self {
            answers: answers.into_iter().collect(),
            asked: Vec::new(),
        }
    }

    /// The rounds that were put to the user, in order.
    pub fn asked(&self) -> &[Challenge] {
        &self.asked
    }

    /// Answers one round; a round the script has no answer for is cancelled.
    fn next(&mut self, challenge: Challenge) -> Option<Vec<String>> {
        self.asked.push(challenge);
        self.answers.pop_front()
    }
}

#[cfg(test)]
mod tests {
    use super::AuthPrompts;

    #[tokio::test]
    async fn an_answer_reaches_the_waiting_connection_exactly_once() {
        let prompts = AuthPrompts::default();
        let (id, answer) = prompts.register();

        prompts
            .answer(&id, Some(vec!["424242".into()]))
            .expect("the waiting connection is told");
        assert_eq!(
            answer.await.expect("answered"),
            Some(vec!["424242".to_string()])
        );

        // Nothing waits under that id any more, so a repeat — the dialog
        // closing behind its own submit — is refused rather than delivered
        // into whatever the server asks next.
        assert!(prompts.answer(&id, None).is_err());
    }
}

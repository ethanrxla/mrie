use std::io;
use std::process;
use std::time::SystemTime;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::backend::Backend;
use ratatui::Terminal;
use serde_json::json;
use serde_json::Value;

use crate::rpc::{RpcEvent, RpcWorker};
use crate::views::{screen_for, Screen, ViewKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
}

impl ConnectionState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Connecting => "CONNECTING",
            Self::Connected => "CONNECTED",
            Self::Disconnected => "OFFLINE",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub text: String,
}

pub struct AppState {
    pub address: String,
    pub connection: ConnectionState,
    pub status: Option<Value>,
    pub telemetry: Option<Value>,
    pub last_error: Option<String>,
    pub last_status_at: Option<Instant>,
    pub input: String,
    pub messages: Vec<ChatMessage>,
    pub ask_pending: bool,
    pub refresh_interval: Duration,
    pub session_id: String,
}

impl AppState {
    pub fn status_age(&self) -> String {
        match self.last_status_at {
            Some(at) => format!("{}s ago", at.elapsed().as_secs()),
            None => "never".to_owned(),
        }
    }
}

pub struct App {
    view: ViewKind,
    screen: Box<dyn Screen>,
    state: AppState,
    rpc: RpcWorker,
    status_pending: bool,
    telemetry_pending: bool,
    last_status_request: Instant,
    should_quit: bool,
}

impl App {
    pub fn new(view: ViewKind, address: String, refresh_interval: Duration) -> Self {
        let rpc = RpcWorker::start(address.clone());
        let mut app = Self {
            view,
            screen: screen_for(view),
            state: AppState {
                address,
                connection: ConnectionState::Connecting,
                status: None,
                telemetry: None,
                last_error: None,
                last_status_at: None,
                input: String::new(),
                messages: vec![ChatMessage {
                    role: ChatRole::System,
                    text: "Conversation channel ready. Ask MRE a question.".to_owned(),
                }],
                ask_pending: false,
                refresh_interval,
                session_id: new_session_id(),
            },
            rpc,
            status_pending: false,
            telemetry_pending: false,
            last_status_request: Instant::now(),
            should_quit: false,
        };
        app.request_refresh();
        app
    }

    pub fn run<B: Backend>(&mut self, terminal: &mut Terminal<B>) -> io::Result<()> {
        while !self.should_quit {
            self.receive_rpc_events();
            self.refresh_if_due();
            terminal.draw(|frame| {
                let area = frame.area();
                self.screen.render(frame, area, &self.state);
            })?;

            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                        self.handle_key(key);
                    }
                }
            }
        }
        Ok(())
    }

    fn request_status(&mut self) {
        if self.status_pending {
            return;
        }
        match self.rpc.request_status() {
            Ok(()) => {
                self.status_pending = true;
                self.last_status_request = Instant::now();
                if self.state.status.is_none() {
                    self.state.connection = ConnectionState::Connecting;
                }
            }
            Err(error) => {
                self.state.connection = ConnectionState::Disconnected;
                self.state.last_error = Some(error);
            }
        }
    }

    fn request_telemetry(&mut self) {
        if self.telemetry_pending {
            return;
        }
        let request = match self.view {
            ViewKind::Security => Some((
                "security.events",
                json!({"limit": 100, "minimum_severity": 0}),
            )),
            ViewKind::Voice => Some(("voice.events", json!({}))),
            _ => None,
        };
        let Some((method, params)) = request else {
            return;
        };
        match self.rpc.request_telemetry(method, params) {
            Ok(()) => self.telemetry_pending = true,
            Err(error) => self.state.last_error = Some(sanitize_untrusted(&error)),
        }
    }

    fn request_refresh(&mut self) {
        self.request_status();
        self.request_telemetry();
    }

    fn refresh_if_due(&mut self) {
        if self.last_status_request.elapsed() >= self.state.refresh_interval {
            self.request_refresh();
        }
    }

    fn receive_rpc_events(&mut self) {
        while let Some(event) = self.rpc.try_event() {
            match event {
                RpcEvent::Status(result) => {
                    self.status_pending = false;
                    match result {
                        Ok(status) => {
                            self.state.status = Some(status);
                            self.state.connection = ConnectionState::Connected;
                            self.state.last_error = None;
                            self.state.last_status_at = Some(Instant::now());
                        }
                        Err(error) => {
                            self.state.connection = ConnectionState::Disconnected;
                            self.state.last_error = Some(error);
                        }
                    }
                }
                RpcEvent::Telemetry(result) => {
                    self.telemetry_pending = false;
                    match result {
                        Ok(telemetry) => self.state.telemetry = Some(telemetry),
                        Err(error) => {
                            self.state.last_error = Some(sanitize_untrusted(&error));
                        }
                    }
                }
                RpcEvent::Answer(result) => {
                    self.state.ask_pending = false;
                    match result {
                        Ok(answer) => self.state.messages.push(ChatMessage {
                            role: ChatRole::Assistant,
                            text: sanitize_untrusted(&answer),
                        }),
                        Err(error) => {
                            let safe_error = sanitize_untrusted(&error);
                            self.state.last_error = Some(safe_error.clone());
                            self.state.messages.push(ChatMessage {
                                role: ChatRole::System,
                                text: format!("Request failed: {safe_error}"),
                            });
                        }
                    }
                }
            }
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        if key.code == KeyCode::Esc {
            self.should_quit = true;
            return;
        }
        if key.code == KeyCode::Char('r') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.request_refresh();
            return;
        }

        if self.view == ViewKind::Conversation {
            self.handle_conversation_key(key);
        } else {
            match key.code {
                KeyCode::Char('q') => self.should_quit = true,
                KeyCode::Char('r') => self.request_refresh(),
                _ => {}
            }
        }
    }

    fn handle_conversation_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => self.submit_question(),
            KeyCode::Backspace => {
                self.state.input.pop();
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                if !character.is_control() {
                    self.state.input.push(character);
                }
            }
            _ => {}
        }
    }

    fn submit_question(&mut self) {
        let question = self.state.input.trim().to_owned();
        if question.is_empty() || self.state.ask_pending {
            return;
        }

        match self
            .rpc
            .ask(question.clone(), self.state.session_id.clone())
        {
            Ok(()) => {
                self.state.messages.push(ChatMessage {
                    role: ChatRole::User,
                    text: question,
                });
                self.state.input.clear();
                self.state.ask_pending = true;
            }
            Err(error) => {
                self.state.last_error = Some(error);
            }
        }
    }
}

fn new_session_id() -> String {
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("tui-{}-{millis}", process::id())
}

pub fn sanitize_untrusted(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            '\n' | '\t' => character,
            _ if character.is_control() => '�',
            _ => character,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sanitize_untrusted;

    #[test]
    fn strips_terminal_control_characters() {
        assert_eq!(
            sanitize_untrusted("safe\u{1b}[31m\nnext"),
            "safe�[31m\nnext"
        );
    }
}

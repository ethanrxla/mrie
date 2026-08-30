use clap::ValueEnum;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;
use serde_json::Value;

use crate::app::{sanitize_untrusted, AppState, ChatRole, ConnectionState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ViewKind {
    Overview,
    Security,
    Feeds,
    Conversation,
    Voice,
}

impl std::fmt::Display for ViewKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Self::Overview => "overview",
            Self::Security => "security",
            Self::Feeds => "feeds",
            Self::Conversation => "conversation",
            Self::Voice => "voice",
        };
        formatter.write_str(name)
    }
}

pub trait Screen {
    fn title(&self) -> &'static str;
    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState);

    fn render(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(4),
                Constraint::Length(3),
            ])
            .split(area);
        render_header(frame, chunks[0], self.title(), state);
        self.render_body(frame, chunks[1], state);
        render_footer(frame, chunks[2], self.title(), state);
    }
}

pub fn screen_for(kind: ViewKind) -> Box<dyn Screen> {
    match kind {
        ViewKind::Overview => Box::new(OverviewScreen),
        ViewKind::Security => Box::new(SecurityScreen),
        ViewKind::Feeds => Box::new(FeedsScreen),
        ViewKind::Conversation => Box::new(ConversationScreen),
        ViewKind::Voice => Box::new(VoiceScreen),
    }
}

struct OverviewScreen;
struct SecurityScreen;
struct FeedsScreen;
struct ConversationScreen;
struct VoiceScreen;

impl Screen for OverviewScreen {
    fn title(&self) -> &'static str {
        "OVERVIEW"
    }

    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(48), Constraint::Percentage(52)])
            .split(area);
        let left = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
            .split(columns[0]);
        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
            .split(columns[1]);

        let agent = vec![
            field_line("Agent", status_text(state, &["agent"])),
            field_line("Version", status_text(state, &["version"])),
            field_line("Endpoint", Some(state.address.clone())),
            field_line("Status age", Some(state.status_age())),
        ];
        render_panel(frame, left[0], "Agent", agent);

        let scheduler = vec![
            field_line("Running", status_text(state, &["scheduler", "running"])),
            field_line("Next run", status_text(state, &["scheduler", "next_run"])),
            field_line("Last run", status_text(state, &["scheduler", "last_run"])),
            field_line("Timezone", status_text(state, &["scheduler", "timezone"])),
            field_line(
                "Loop hours",
                status_text(state, &["scheduler", "loop_hours"]),
            ),
        ];
        render_panel(frame, left[1], "Briefing scheduler", scheduler);

        let provider = vec![
            field_line("Provider", status_text(state, &["provider", "name"])),
            field_line("Primary", status_text(state, &["provider", "primary"])),
            field_line("Model", primary_provider_text(state, "model")),
            field_line("Configured", primary_provider_text(state, "configured")),
            field_line("Rate limit", primary_provider_text(state, "rate_limit_rpm")),
        ];
        render_panel(frame, right[0], "Model provider", provider);

        let capabilities = capability_names(state);
        let lines = if capabilities.is_empty() {
            vec![Line::from("Waiting for capability inventory...")]
        } else {
            capabilities
                .into_iter()
                .map(|name| Line::from(format!("  • {name}")))
                .collect()
        };
        render_panel(frame, right[1], "Capabilities", lines);
    }
}

impl Screen for SecurityScreen {
    fn title(&self) -> &'static str {
        "SECURITY SENTINEL"
    }

    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(38), Constraint::Percentage(62)])
            .split(area);

        let security_caps = filtered_capabilities(
            state,
            &[
                "wazuh",
                "security",
                "sentinel",
                "honeypot",
                "threat",
                "network",
                "tailscale",
                "filesystem",
                "audit",
            ],
        );
        let mut lines = vec![field_line("IPC", Some(state.connection.label().to_owned()))];
        lines.push(Line::from(""));
        lines.extend(if security_caps.is_empty() {
            vec![Line::from("No security capabilities reported yet.")]
        } else {
            security_caps
                .into_iter()
                .map(|name| Line::from(format!("  • {name}")))
                .collect()
        });
        render_panel(frame, columns[0], "Sentinel capabilities", lines);

        let telemetry = state
            .telemetry
            .as_ref()
            .or_else(|| first_status_value(state, &["security", "sentinel", "wazuh", "honeypot"]));
        let text = match telemetry {
            Some(value) => pretty_json(value),
            None => concat!(
                "No security telemetry object is present in the current status response.\n\n",
                "MRE is connected and will render Wazuh, honeypot, alert, and threat ",
                "fields here as the backend exposes them. Capability presence is shown at left."
            )
            .to_owned(),
        };
        render_text_panel(frame, columns[1], "Live telemetry", text);
    }
}

impl Screen for FeedsScreen {
    fn title(&self) -> &'static str {
        "INTELLIGENCE FEEDS"
    }

    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(34), Constraint::Percentage(66)])
            .split(area);
        let feed_caps = filtered_capabilities(
            state,
            &["news", "web", "youtube", "instagram", "social", "feed"],
        );
        let mut lines = vec![
            field_line(
                "Next briefing",
                status_text(state, &["scheduler", "next_run"]),
            ),
            field_line(
                "Last briefing",
                status_text(state, &["scheduler", "last_run"]),
            ),
            field_line("Window", status_text(state, &["scheduler", "loop_hours"])),
            Line::from(""),
        ];
        lines.extend(if feed_caps.is_empty() {
            vec![Line::from("No feed capabilities reported yet.")]
        } else {
            feed_caps
                .into_iter()
                .map(|name| Line::from(format!("  • {name}")))
                .collect()
        });
        render_panel(frame, columns[0], "Sources and cadence", lines);

        let briefings = status_value(state, &["last_briefings"]);
        let text = match briefings {
            Some(Value::Array(items)) if !items.is_empty() => items
                .iter()
                .rev()
                .map(format_briefing)
                .collect::<Vec<_>>()
                .join("\n\n────────────────────────\n\n"),
            _ => "No completed briefings are present in the status snapshot.".to_owned(),
        };
        render_text_panel(frame, columns[1], "Recent briefings", text);
    }
}

impl Screen for ConversationScreen {
    fn title(&self) -> &'static str {
        "CONVERSATION"
    }

    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Min(3), Constraint::Length(3)])
            .split(area);

        let mut lines = Vec::new();
        for message in state
            .messages
            .iter()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let (label, color) = match message.role {
                ChatRole::User => ("YOU", Color::Cyan),
                ChatRole::Assistant => ("MRE", Color::Green),
                ChatRole::System => ("SYSTEM", Color::Yellow),
            };
            lines.push(Line::from(Span::styled(
                label,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )));
            lines.extend(
                message
                    .text
                    .lines()
                    .map(|line| Line::from(format!("  {line}"))),
            );
            lines.push(Line::from(""));
        }
        if state.ask_pending {
            lines.push(Line::from(Span::styled(
                "MRE is thinking...",
                Style::default().fg(Color::Yellow),
            )));
        }
        let visible_height = rows[0].height.saturating_sub(2) as usize;
        let content_width = rows[0].width.saturating_sub(2).max(1) as usize;
        let wrapped_line_count = lines
            .iter()
            .map(|line| line.width().max(1).div_ceil(content_width))
            .sum::<usize>();
        let transcript = Paragraph::new(Text::from(lines))
            .block(Block::default().borders(Borders::ALL).title("Transcript"))
            .wrap(Wrap { trim: false });
        let scroll = wrapped_line_count
            .saturating_sub(visible_height)
            .min(u16::MAX as usize) as u16;
        let transcript = transcript.scroll((scroll, 0));
        frame.render_widget(transcript, rows[0]);

        let prompt = if state.ask_pending {
            "Waiting for response"
        } else {
            "Ask MRE — Enter to send"
        };
        let input = Paragraph::new(state.input.as_str())
            .block(Block::default().borders(Borders::ALL).title(prompt));
        frame.render_widget(input, rows[1]);
        if !state.ask_pending {
            let cursor_x = rows[1]
                .x
                .saturating_add(1)
                .saturating_add(state.input.chars().count() as u16)
                .min(rows[1].right().saturating_sub(2));
            frame.set_cursor_position((cursor_x, rows[1].y.saturating_add(1)));
        }
    }
}

impl Screen for VoiceScreen {
    fn title(&self) -> &'static str {
        "VOICE & SPEECH LOG"
    }

    fn render_body(&self, frame: &mut Frame<'_>, area: Rect, state: &AppState) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
            .split(area);
        let voice_caps = filtered_capabilities(state, &["voice", "audio", "speech"]);
        let lines = if voice_caps.is_empty() {
            vec![Line::from("No voice capabilities reported yet.")]
        } else {
            voice_caps
                .into_iter()
                .map(|name| Line::from(format!("  • {name}")))
                .collect()
        };
        render_panel(frame, columns[0], "Voice pipeline", lines);

        let voice_status = state
            .telemetry
            .as_ref()
            .or_else(|| first_status_value(state, &["voice", "audio_input", "speech_log"]));
        let text = match voice_status {
            Some(value) => pretty_json(value),
            None => concat!(
                "The status endpoint currently reports voice components through the capability ",
                "inventory only. Runtime speech, microphone, and speech-log health will appear ",
                "here when those structured status fields are exposed.\n\n",
                "Recent spoken briefing summaries remain available in the feeds screen."
            )
            .to_owned(),
        };
        render_text_panel(frame, columns[1], "Speech status", text);
    }
}

fn render_header(frame: &mut Frame<'_>, area: Rect, title: &str, state: &AppState) {
    let color = match state.connection {
        ConnectionState::Connected => Color::Green,
        ConnectionState::Connecting => Color::Yellow,
        ConnectionState::Disconnected => Color::Red,
    };
    let line = Line::from(vec![
        Span::styled(
            " MRE ",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!("{title}   ")),
        Span::styled(
            state.connection.label(),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!("   {}", state.address)),
    ]);
    frame.render_widget(
        Paragraph::new(line).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, title: &str, state: &AppState) {
    let help = if title == "CONVERSATION" {
        "Enter send  Esc quit  Ctrl+R refresh  Ctrl+C quit"
    } else {
        "R refresh  Q/Esc quit  Ctrl+C quit"
    };
    let detail = state
        .last_error
        .as_deref()
        .map(|error| format!("Error: {error}"))
        .unwrap_or_else(|| {
            format!(
                "Status {} · refresh every {}s",
                state.status_age(),
                state.refresh_interval.as_secs()
            )
        });
    let lines = vec![
        Line::from(Span::styled(help, Style::default().fg(Color::DarkGray))),
        Line::from(detail),
    ];
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_panel(frame: &mut Frame<'_>, area: Rect, title: &str, lines: Vec<Line<'static>>) {
    frame.render_widget(
        Paragraph::new(lines)
            .block(Block::default().borders(Borders::ALL).title(title))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn render_text_panel(frame: &mut Frame<'_>, area: Rect, title: &str, text: String) {
    frame.render_widget(
        Paragraph::new(text)
            .block(Block::default().borders(Borders::ALL).title(title))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn field_line(label: &str, value: Option<String>) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{label}: "),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw(value.unwrap_or_else(|| "—".to_owned())),
    ])
}

fn status_value<'a>(state: &'a AppState, path: &[&str]) -> Option<&'a Value> {
    let mut value = state.status.as_ref()?;
    for key in path {
        value = value.get(*key)?;
    }
    Some(value)
}

fn status_text(state: &AppState, path: &[&str]) -> Option<String> {
    value_text(status_value(state, path)?)
}

fn primary_provider_text(state: &AppState, key: &str) -> Option<String> {
    let provider = status_value(state, &["provider"])?;
    let nested = provider
        .get("primary")
        .and_then(Value::as_str)
        .and_then(|primary| provider.get("providers")?.get(primary))
        .and_then(|details| details.get(key));
    nested.or_else(|| provider.get(key)).and_then(value_text)
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Bool(true) => Some("yes".to_owned()),
        Value::Bool(false) => Some("no".to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::String(value) => Some(sanitize_untrusted(value)),
        _ => None,
    }
}

fn capability_names(state: &AppState) -> Vec<String> {
    status_value(state, &["capabilities"])
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn filtered_capabilities(state: &AppState, needles: &[&str]) -> Vec<String> {
    capability_names(state)
        .into_iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            needles.iter().any(|needle| lower.contains(needle))
        })
        .collect()
}

fn first_status_value<'a>(state: &'a AppState, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| status_value(state, &[*key]))
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn format_briefing(value: &Value) -> String {
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or("unknown time");
    let summary = value
        .get("summary")
        .and_then(Value::as_str)
        .filter(|summary| !summary.is_empty())
        .unwrap_or("No spoken summary (possibly a dry run).");
    let sources = value
        .pointer("/collected/sources")
        .and_then(Value::as_object)
        .map(|sources| sources.keys().cloned().collect::<Vec<_>>().join(", "))
        .filter(|sources| !sources.is_empty())
        .unwrap_or_else(|| "none reported".to_owned());
    sanitize_untrusted(&format!("{timestamp}\nSources: {sources}\n\n{summary}"))
}

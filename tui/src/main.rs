mod app;
mod rpc;
mod views;

use std::error::Error;
use std::io::{self, stdout};
use std::time::Duration;

use app::App;
use clap::Parser;
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use views::ViewKind;

#[derive(Debug, Parser)]
#[command(
    name = "mrie-tui",
    version,
    about = "Multi-screen terminal interface for MRE"
)]
struct Cli {
    /// Screen displayed by this terminal instance.
    #[arg(long, value_enum, default_value_t = ViewKind::Overview)]
    view: ViewKind,

    /// MRE newline-delimited JSON-RPC TCP endpoint.
    #[arg(long, default_value = "127.0.0.1:17351")]
    address: String,

    /// Seconds between status requests.
    #[arg(
        long,
        default_value_t = 5,
        value_parser = clap::value_parser!(u64).range(1..=3600)
    )]
    refresh_seconds: u64,
}

fn main() -> Result<(), Box<dyn Error>> {
    let cli = Cli::parse();
    let mut terminal = TerminalSession::start()?;
    let mut app = App::new(
        cli.view,
        cli.address,
        Duration::from_secs(cli.refresh_seconds),
    );
    let result = app.run(terminal.terminal_mut());
    drop(terminal);
    result.map_err(Into::into)
}

/// Owns terminal mode changes so normal errors always restore the user's shell.
struct TerminalSession {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
}

impl TerminalSession {
    fn start() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut output = stdout();
        if let Err(error) = execute!(output, EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(error);
        }

        match Terminal::new(CrosstermBackend::new(output)) {
            Ok(terminal) => Ok(Self { terminal }),
            Err(error) => {
                let _ = disable_raw_mode();
                let _ = execute!(stdout(), LeaveAlternateScreen);
                Err(error)
            }
        }
    }

    fn terminal_mut(&mut self) -> &mut Terminal<CrosstermBackend<io::Stdout>> {
        &mut self.terminal
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_every_documented_view() {
        for name in ["overview", "security", "feeds", "conversation", "voice"] {
            let cli = Cli::try_parse_from(["mrie-tui", "--view", name])
                .unwrap_or_else(|error| panic!("view {name} should parse: {error}"));
            assert_eq!(cli.view.to_string(), name);
        }
    }
}

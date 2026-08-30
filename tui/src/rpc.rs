use std::io::{BufRead, BufReader, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

/// Transport abstraction keeps protocol details independent from the TUI.
pub trait RpcTransport: Send {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String>;
}

/// Newline-delimited JSON-RPC 2.0 client for the Python IPC server.
pub struct TcpJsonRpcClient {
    address: String,
    next_id: u64,
    connect_timeout: Duration,
    status_timeout: Duration,
    ask_timeout: Duration,
}

impl TcpJsonRpcClient {
    pub fn new(address: String) -> Self {
        Self {
            address,
            next_id: 1,
            connect_timeout: Duration::from_secs(2),
            status_timeout: Duration::from_secs(5),
            ask_timeout: Duration::from_secs(300),
        }
    }

    fn connect(&self, read_timeout: Duration) -> Result<TcpStream, String> {
        let socket = self
            .address
            .to_socket_addrs()
            .map_err(|error| format!("cannot resolve {}: {error}", self.address))?
            .next()
            .ok_or_else(|| format!("{} resolved to no addresses", self.address))?;

        let stream = TcpStream::connect_timeout(&socket, self.connect_timeout)
            .map_err(|error| format!("cannot connect to {}: {error}", self.address))?;
        stream
            .set_read_timeout(Some(read_timeout))
            .map_err(|error| format!("cannot set read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(self.status_timeout))
            .map_err(|error| format!("cannot set write timeout: {error}"))?;
        Ok(stream)
    }
}

impl RpcTransport for TcpJsonRpcClient {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let request_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let timeout = if method == "ask" {
            self.ask_timeout
        } else {
            self.status_timeout
        };
        let mut stream = self.connect(timeout)?;
        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });

        serde_json::to_writer(&mut stream, &request)
            .map_err(|error| format!("cannot encode request: {error}"))?;
        stream
            .write_all(b"\n")
            .and_then(|_| stream.flush())
            .map_err(|error| format!("cannot send request: {error}"))?;

        let mut line = String::new();
        BufReader::new(stream)
            .read_line(&mut line)
            .map_err(|error| format!("cannot read response: {error}"))?;
        if line.trim().is_empty() {
            return Err("server closed the connection without a response".to_owned());
        }

        let response: Value = serde_json::from_str(&line)
            .map_err(|error| format!("server returned invalid JSON: {error}"))?;
        if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err("server response is not JSON-RPC 2.0".to_owned());
        }
        if response.get("id").and_then(Value::as_u64) != Some(request_id) {
            return Err(format!("response id does not match request {request_id}"));
        }
        if let Some(error) = response.get("error") {
            let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32000);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown server error");
            return Err(format!("RPC {code}: {message}"));
        }

        response
            .get("result")
            .cloned()
            .ok_or_else(|| "server response has no result".to_owned())
    }
}

enum RpcCommand {
    Status,
    Telemetry { method: String, params: Value },
    Ask { message: String, session_id: String },
    Shutdown,
}

pub enum RpcEvent {
    Status(Result<Value, String>),
    Telemetry(Result<Value, String>),
    Answer(Result<String, String>),
}

/// Serializes network work on a background thread so terminal input never blocks.
pub struct RpcWorker {
    command_tx: Sender<RpcCommand>,
    event_rx: Receiver<RpcEvent>,
}

impl RpcWorker {
    pub fn start(address: String) -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();

        thread::spawn(move || {
            let mut client: Box<dyn RpcTransport> = Box::new(TcpJsonRpcClient::new(address));
            while let Ok(command) = command_rx.recv() {
                match command {
                    RpcCommand::Status => {
                        let result = client.call("status", json!({}));
                        if event_tx.send(RpcEvent::Status(result)).is_err() {
                            break;
                        }
                    }
                    RpcCommand::Telemetry { method, params } => {
                        let result = client.call(&method, params);
                        if event_tx.send(RpcEvent::Telemetry(result)).is_err() {
                            break;
                        }
                    }
                    RpcCommand::Ask {
                        message,
                        session_id,
                    } => {
                        let result = client
                            .call(
                                "ask",
                                json!({ "message": message, "session_id": session_id }),
                            )
                            .and_then(|value| {
                                value
                                    .get("response")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .ok_or_else(|| {
                                        "ask response has no string `response` field".to_owned()
                                    })
                            });
                        if event_tx.send(RpcEvent::Answer(result)).is_err() {
                            break;
                        }
                    }
                    RpcCommand::Shutdown => break,
                }
            }
        });

        Self {
            command_tx,
            event_rx,
        }
    }

    pub fn request_status(&self) -> Result<(), String> {
        self.command_tx
            .send(RpcCommand::Status)
            .map_err(|_| "RPC worker has stopped".to_owned())
    }

    pub fn request_telemetry(&self, method: &str, params: Value) -> Result<(), String> {
        self.command_tx
            .send(RpcCommand::Telemetry {
                method: method.to_owned(),
                params,
            })
            .map_err(|_| "RPC worker has stopped".to_owned())
    }

    pub fn ask(&self, message: String, session_id: String) -> Result<(), String> {
        self.command_tx
            .send(RpcCommand::Ask {
                message,
                session_id,
            })
            .map_err(|_| "RPC worker has stopped".to_owned())
    }

    pub fn try_event(&self) -> Option<RpcEvent> {
        match self.event_rx.try_recv() {
            Ok(event) => Some(event),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
        }
    }
}

impl Drop for RpcWorker {
    fn drop(&mut self) {
        let _ = self.command_tx.send(RpcCommand::Shutdown);
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn sends_and_receives_newline_delimited_json_rpc() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener
            .local_addr()
            .expect("test server address")
            .to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept client");
            let mut request_line = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request_line)
                .expect("read request");
            assert!(request_line.ends_with('\n'));
            let request: Value = serde_json::from_str(&request_line).expect("valid request JSON");
            assert_eq!(request["jsonrpc"], "2.0");
            assert_eq!(request["method"], "status");
            assert_eq!(request["params"], json!({}));

            let response = json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"agent": "MRE"},
            });
            serde_json::to_writer(&mut stream, &response).expect("write response");
            stream.write_all(b"\n").expect("terminate response");
        });

        let mut client = TcpJsonRpcClient::new(address);
        let result = client.call("status", json!({})).expect("RPC succeeds");
        assert_eq!(result["agent"], "MRE");
        server.join().expect("test server finishes");
    }
}

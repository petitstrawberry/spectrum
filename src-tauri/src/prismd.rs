//! prismd IPC client for communicating with the Prism daemon

use serde::{Deserialize, Serialize};
use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

const PRISMD_SOCKET_PATH: &str = "/tmp/prismd.sock";

// --- IPC Types ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum CommandRequest {
    Clients,
    Set { pid: i32, offset: u32 },
    SetApp { app_name: String, offset: u32 },
    SetClient { client_id: u32, offset: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse<T> {
    pub status: String,
    pub message: Option<String>,
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub pid: i32,
    pub client_id: u32,
    pub channel_offset: u32,
    pub process_name: Option<String>,
    pub responsible_pid: Option<i32>,
    pub responsible_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingUpdate {
    pub pid: i32,
    pub channel_offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRoutingUpdate {
    pub client_id: u32,
    pub channel_offset: u32,
}

// --- Helper Functions ---

fn send_request<T: for<'de> Deserialize<'de>>(request: &CommandRequest) -> Result<T, Box<dyn Error + Send + Sync>> {
    let mut stream = UnixStream::connect(PRISMD_SOCKET_PATH)?;

    let payload = serde_json::to_string(request)?;
    stream.write_all(payload.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;

    stream.shutdown(std::net::Shutdown::Write)?;

    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader.read_line(&mut response)?;

    let parsed: RpcResponse<T> = serde_json::from_str(&response)?;

    if parsed.status != "ok" {
        return Err(parsed.message.unwrap_or_else(|| "Unknown error".to_string()).into());
    }

    parsed.data.ok_or_else(|| "No data in response".into())
}

// --- Public API ---

/// Get list of Prism clients from prismd
pub async fn get_clients() -> Result<Vec<ClientInfo>, Box<dyn Error + Send + Sync>> {
    // Use blocking I/O in a separate thread to not block the async runtime
    tokio::task::spawn_blocking(|| {
        match send_request::<Vec<ClientInfo>>(&CommandRequest::Clients) {
            Ok(clients) => Ok(clients),
            Err(e) => {
                // If prismd is not running, return empty list
                if e.to_string().contains("connect") {
                    Ok(vec![])
                } else {
                    Err(e)
                }
            }
        }
    }).await?
}

/// Set routing for a specific PID
pub async fn set_routing(pid: i32, offset: u32) -> Result<RoutingUpdate, Box<dyn Error + Send + Sync>> {
    tokio::task::spawn_blocking(move || {
        send_request::<RoutingUpdate>(&CommandRequest::Set { pid, offset })
    }).await?
}

/// Set routing for all clients of an app
pub async fn set_app_routing(app_name: String, offset: u32) -> Result<Vec<RoutingUpdate>, Box<dyn Error + Send + Sync>> {
    tokio::task::spawn_blocking(move || {
        send_request::<Vec<RoutingUpdate>>(&CommandRequest::SetApp { app_name, offset })
    }).await?
}

/// Set routing for a specific client ID
pub async fn set_client_routing(client_id: u32, offset: u32) -> Result<ClientRoutingUpdate, Box<dyn Error + Send + Sync>> {
    tokio::task::spawn_blocking(move || {
        send_request::<ClientRoutingUpdate>(&CommandRequest::SetClient { client_id, offset })
    }).await?
}

/// Check if prismd is running
pub fn is_connected() -> bool {
    UnixStream::connect(PRISMD_SOCKET_PATH).is_ok()
}

/// Process info for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub channel_offset: u32,
}

/// Get list of processes from prismd (sync version for UI)
pub fn get_processes() -> Vec<ProcessInfo> {
    match send_request::<Vec<ClientInfo>>(&CommandRequest::Clients) {
        Ok(clients) => {
            clients
                .into_iter()
                .map(|c| ProcessInfo {
                    pid: c.pid as u32,
                    name: c.responsible_name
                        .or(c.process_name)
                        .unwrap_or_else(|| format!("PID {}", c.pid)),
                    channel_offset: c.channel_offset,
                })
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

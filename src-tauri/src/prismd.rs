//! prismd IPC client for communicating with the Prism daemon

use crate::PrismClient;
use std::error::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const PRISMD_SOCKET_PATH: &str = "/tmp/prismd.sock";

/// Get list of Prism clients from prismd
pub async fn get_clients() -> Result<Vec<PrismClient>, Box<dyn Error + Send + Sync>> {
    let stream = match UnixStream::connect(PRISMD_SOCKET_PATH).await {
        Ok(s) => s,
        Err(_) => {
            // prismd not running, return empty list
            return Ok(vec![]);
        }
    };

    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    // Send Clients command
    writer.write_all(b"Clients\n").await?;
    writer.flush().await?;

    let mut clients = Vec::new();
    let mut line = String::new();

    while reader.read_line(&mut line).await? > 0 {
        let trimmed = line.trim();
        
        if trimmed == "End" {
            break;
        }

        if trimmed.starts_with("Client:") {
            if let Some(client) = parse_client_line(trimmed) {
                clients.push(client);
            }
        }

        line.clear();
    }

    Ok(clients)
}

fn parse_client_line(line: &str) -> Option<PrismClient> {
    // Format: Client: PID=1234 ClientId=1 ChannelOffset=0 ProcessName=Spotify ResponsiblePid=... ResponsibleName=...
    let parts: std::collections::HashMap<&str, &str> = line
        .strip_prefix("Client: ")?
        .split_whitespace()
        .filter_map(|part| {
            let mut split = part.splitn(2, '=');
            Some((split.next()?, split.next()?))
        })
        .collect();

    Some(PrismClient {
        pid: parts.get("PID")?.parse().ok()?,
        client_id: parts.get("ClientId")?.parse().ok()?,
        channel_offset: parts.get("ChannelOffset")?.parse().ok()?,
        process_name: parts.get("ProcessName").map(|s| s.to_string()),
        responsible_pid: parts.get("ResponsiblePid").and_then(|s| s.parse().ok()),
        responsible_name: parts.get("ResponsibleName").map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_client_line() {
        let line = "Client: PID=1234 ClientId=1 ChannelOffset=0 ProcessName=Spotify";
        let client = parse_client_line(line).unwrap();
        assert_eq!(client.pid, 1234);
        assert_eq!(client.client_id, 1);
        assert_eq!(client.channel_offset, 0);
        assert_eq!(client.process_name, Some("Spotify".to_string()));
    }
}

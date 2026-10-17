//! Debug client: prints the event stream of a running huntawayd.
//! Usage: cargo run -p huntawayd --example stream -- <ws://host:port> <token> [since] [epoch]

use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (base, token) = (&args[1], &args[2]);
    let mut url = format!("{base}/v1/stream?token={token}");
    if let (Some(since), Some(epoch)) = (args.get(3), args.get(4)) {
        url.push_str(&format!("&since={since}&epoch={epoch}"));
    }
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;
    while let Some(msg) = ws.next().await {
        if let Message::Text(text) = msg? {
            println!("{text}");
        }
    }
    Ok(())
}

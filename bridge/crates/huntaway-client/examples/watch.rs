//! `cargo run -p huntaway-client --example watch -- <host:port> <token> [agent id]`:
//! prints stream events, or the live terminal of an agent.

use huntaway_client::stream::{self, StreamEvent};
use huntaway_client::terminal::{self, TerminalEvent};
use huntaway_client::Client;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let client = Client::new(vec![args[0].clone()], args[1].clone());
    if let Some(agent) = args.get(2) {
        let (_handle, mut rx) = terminal::open(&client, agent).await.expect("terminal");
        let mut n = 0;
        while let Some(ev) = rx.recv().await {
            match ev {
                TerminalEvent::Screen { ansi } => println!("screen: {} bytes", ansi.len()),
                other => println!("{other:?}"),
            }
            n += 1;
            if n == 2 {
                break;
            }
        }
        return;
    }
    let (_handle, mut rx) = stream::spawn(client);
    let mut n = 0;
    while let Some(ev) = rx.recv().await {
        match ev {
            StreamEvent::Snapshot(s) => println!("snapshot: {} agents, seq {}", s.agents.len(), s.seq),
            StreamEvent::Event(e) => println!("event {} {} {:?}", e.seq, e.kind, e.agent_id),
            other => println!("{other:?}"),
        }
        n += 1;
        if n == 6 {
            break;
        }
    }
}

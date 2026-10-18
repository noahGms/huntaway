//! `cargo run -p huntaway-client --example pair -- <link>`: pairs and prints the result.

#[tokio::main]
async fn main() {
    let link = std::env::args().nth(1).expect("link");
    let payload = huntaway_client::pairing::parse(&link).expect("valid link");
    match huntaway_client::pairing::pair(&payload, "test desktop").await {
        Ok(p) => {
            println!("paired: {} ({}) via {}, permissions {:?}", p.machine_name, p.machine_id, p.address, p.permissions);
            let client = huntaway_client::Client::new(p.addresses, p.token);
            let state = client.state().await.expect("state");
            println!("{} agents", state.agents.len());
        }
        Err(e) => println!("error: {e}"),
    }
}

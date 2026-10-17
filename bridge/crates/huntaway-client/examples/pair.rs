//! `cargo run -p huntaway-client --example pair -- <link>`: pairs and prints the result.

#[tokio::main]
async fn main() {
    let link = std::env::args().nth(1).expect("lien");
    let payload = huntaway_client::pairing::parse(&link).expect("lien valide");
    match huntaway_client::pairing::pair(&payload, "test desktop").await {
        Ok(p) => {
            println!("appairé : {} ({}) via {}, permissions {:?}", p.machine_name, p.machine_id, p.address, p.permissions);
            let client = huntaway_client::Client::new(p.addresses, p.token);
            let state = client.state().await.expect("state");
            println!("{} agents", state.agents.len());
        }
        Err(e) => println!("erreur : {e}"),
    }
}

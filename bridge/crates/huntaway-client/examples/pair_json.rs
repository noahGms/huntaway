//! `cargo run -p huntaway-client --example pair_json -- <link> <device name>`:
//! pairs and prints the result as JSON (machine record + token), for scripts.

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let link = args.next().expect("lien");
    let name = args.next().unwrap_or_else(|| "Huntaway Desktop".into());
    let payload = huntaway_client::pairing::parse(&link).expect("lien valide");
    let p = huntaway_client::pairing::pair(&payload, &name).await.expect("appairage");
    println!(
        "{}",
        serde_json::json!({
            "machine_id": p.machine_id, "name": p.machine_name, "addresses": p.addresses,
            "public_key": p.public_key, "device_id": p.device_id, "permissions": p.permissions, "token": p.token
        })
    );
}

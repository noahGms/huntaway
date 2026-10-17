#!/usr/bin/env python3
"""Done/Blocked rule bench (PRD §11.2) on real agents, through a running huntawayd.

Each scenario drives an agent through the Huntaway API (message, choice, deny,
interrupt), records the notifications huntawayd emits on its event stream, and
compares them with the expected ones.

Usage:
  rule_bench.py --base http://127.0.0.1:7421 --token <full token> \
      --stream <file written by `cargo run --example stream`> \
      --claude default:w4:p1 [--codex default:w4:p9] [--out results.json]
"""
import argparse
import json
import time
import urllib.error
import urllib.request


class Api:
    def __init__(self, base, token):
        self.base, self.token = base, token

    def call(self, method, path, body=None):
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    def agent(self, aid):
        return self.call("GET", f"/v1/agents/{aid}")


def wait(api, aid, statuses, timeout=90):
    """Waits until the agent attention status is in `statuses`."""
    end = time.time() + timeout
    while time.time() < end:
        a = api.agent(aid)
        if a.get("attention", {}).get("status") in statuses:
            return a
        time.sleep(1)
    return api.agent(aid)


def notifications(stream_file, aid, since_ms):
    out = []
    for line in open(stream_file):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "notification" and e.get("agent_id") == aid and e.get("at", 0) >= since_ms:
            out.append(e["data"]["kind"])
    return out


def run(api, stream, aid, name, steps, expected):
    start = int(time.time() * 1000)
    reasons = []
    for step in steps:
        kind, arg = step
        if kind == "send":
            r = api.call("POST", f"/v1/agents/{aid}/messages", {"text": arg})
            if not r.get("ok"):
                print(f"  ! send: {r}")
            time.sleep(2)
        elif kind == "await_blocked":
            a = wait(api, aid, {"blocked"}, timeout=arg or 90)
            reasons.append((a.get("attention") or {}).get("reason"))
            # A human takes a moment to read the card.
            time.sleep(2)
        elif kind == "choice":
            api.call("POST", f"/v1/agents/{aid}/choice", {"number": arg})
            time.sleep(2)
        elif kind == "choice_text":
            n, text = arg
            api.call("POST", f"/v1/agents/{aid}/choice", {"number": n, "text": text})
            time.sleep(2)
        elif kind == "deny":
            api.call("POST", f"/v1/agents/{aid}/deny", {"text": arg})
            time.sleep(2)
        elif kind == "sleep":
            time.sleep(arg)
        elif kind == "interrupt":
            api.call("POST", f"/v1/agents/{aid}/interrupt")
            time.sleep(2)
    # Let the turn end and the 1.5 s debounce settle.
    wait(api, aid, {"done", "idle", "blocked"}, timeout=120)
    time.sleep(6)
    got = notifications(stream, aid, start)
    final = api.agent(aid).get("attention", {})
    ok = got == expected["notifications"] and all(
        r == e for r, e in zip(reasons, expected.get("reasons", reasons))
    )
    print(f"{'✓' if ok else '✗'} {name}: notifications {got} (attendu {expected['notifications']}), "
          f"motifs {reasons}, état final {final}")
    return {"scenario": name, "ok": ok, "notifications": got, "expected": expected, "reasons": reasons, "final": final}


CLAUDE = [
    ("réponse simple", [("send", "Réponds juste: OK1")], {"notifications": ["done"]}),
    ("approbation acceptée",
     [("send", "Crée le fichier bench1.txt avec exactement la commande Bash: echo b > bench1.txt"),
      ("await_blocked", 60), ("choice", 1)],
     {"notifications": ["blocked", "done"], "reasons": ["approval"]}),
    ("approbation refusée avec explication",
     [("send", "Supprime bench1.txt avec la commande Bash: rm bench1.txt"),
      ("await_blocked", 60), ("deny", "Non, garde-le. Réponds juste: GARDÉ")],
     {"notifications": ["blocked", "done"], "reasons": ["approval"]}),
    ("question à choix",
     [("send", "Utilise l'outil AskUserQuestion pour me demander ma saison préférée, options Été et Hiver. Ensuite réponds juste avec ma réponse."),
      ("await_blocked", 60), ("choice", 2)],
     {"notifications": ["blocked", "done"], "reasons": ["question"]}),
    ("question à réponse libre",
     [("send", "Utilise l'outil AskUserQuestion pour me demander ma ville préférée, options Paris et Lyon. Ensuite réponds juste avec ma réponse."),
      ("await_blocked", 60), ("choice_text", (3, "Nantes"))],
     {"notifications": ["blocked", "done"], "reasons": ["question"]}),
    ("question en texte libre",
     [("send", "Pose-moi simplement une question en texte (sans outil) : demande-moi ma couleur préférée. Termine ta réponse par la question.")],
     {"notifications": ["blocked"], "reasons": []}),
    ("réponse à la question texte",
     [("send", "Bleu. Réponds juste: NOTÉ")], {"notifications": ["done"]}),
    ("interruption depuis Huntaway",
     [("send", "Écris un très long texte de 3000 mots sur les chiens de berger, directement dans ta réponse."),
      ("sleep", 4), ("interrupt", None)],
     {"notifications": []}),
    ("liste de tâches",
     [("send", "Utilise l'outil TodoWrite pour créer 2 tâches (Lire, Écrire), marque-les terminées, puis réponds juste: TÂCHES OK")],
     {"notifications": ["done"]}),
]

CODEX = [
    ("codex réponse simple", [("send", "Réponds juste: CODEX OK1")], {"notifications": ["done"]}),
    ("codex approbation réseau",
     [("send", "Exécute exactement cette commande (elle a besoin du réseau, demande la permission): curl -sI https://example.com"),
      ("await_blocked", 90), ("choice", 1)],
     {"notifications": ["blocked", "done"], "reasons": ["approval"]}),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--stream", required=True)
    ap.add_argument("--claude")
    ap.add_argument("--codex")
    ap.add_argument("--out", default="rule_bench.json")
    args = ap.parse_args()
    api = Api(args.base, args.token)
    results = []
    for aid, scenarios in ((args.claude, CLAUDE), (args.codex, CODEX)):
        if not aid:
            continue
        for name, steps, expected in scenarios:
            results.append(run(api, args.stream, aid, name, steps, expected))
    passed = sum(r["ok"] for r in results)
    print(f"\n{passed}/{len(results)} scénarios conformes")
    json.dump(results, open(args.out, "w"), ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

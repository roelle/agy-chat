"""The server, end to end over HTTP, against a real (temporary) team directory."""
import http.client
import json
import threading
import time
from pathlib import Path

import pytest

from agychat.server import App, serve
from agyteam.transport_file import FileTransport


@pytest.fixture
def team(tmp_path, monkeypatch):
    root = tmp_path / "teams"
    td = root / "demo" / "team"
    (td / "inbox").mkdir(parents=True)
    ws = tmp_path / "work"
    ws.mkdir()
    (ws / "report.md").write_text("# Findings\n\n- allocate drops a cent\n")
    (td / "roster.json").write_text(json.dumps({"agents": [
        {"name": "tpm", "role": "coordinates"},
        {"name": "coder", "role": "implements", "model": "flash", "workspaces": [str(ws)]},
        {"name": "qa", "role": "reviews", "model": "pro"}]}))
    monkeypatch.setenv("AGYTEAM_TEAM_DIR", str(td))
    monkeypatch.delenv("AGYTEAM_AGENT", raising=False)
    monkeypatch.delenv("AGYTEAM_BUS_TRANSPORT", raising=False)
    return root, td, ws


@pytest.fixture
def server(team):
    root, td, ws = team
    app = App(root, [], "matt")
    httpd = serve(app, "127.0.0.1", 0)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield app, httpd.server_address[1], td, ws
    httpd.shutdown()


def call(port, method, path, body=None, token=None, host="127.0.0.1", ctype="application/json"):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Host": f"{host}:{port}"}
    if token:
        headers["X-Token"] = token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = ctype
    c.request(method, path, body=data, headers=headers)
    r = c.getresponse()
    raw = r.read()
    try:
        return r.status, json.loads(raw)
    except ValueError:
        return r.status, raw.decode(errors="replace")


# --- who may talk to it --------------------------------------------------------

def test_the_api_needs_the_token(server):
    app, port, *_ = server
    assert call(port, "GET", "/api/teams")[0] == 401
    status, body = call(port, "GET", "/api/teams", token=app.token)
    assert status == 200 and [t["name"] for t in body["teams"]] == ["demo"]


def test_a_page_from_another_host_name_is_refused(server):
    app, port, *_ = server
    assert call(port, "GET", "/api/teams", token=app.token, host="evil.example")[0] == 403


def test_a_change_must_be_json(server):
    app, port, *_ = server
    status, _ = call(port, "POST", "/api/post", {"team": "demo", "channel": "general",
                                                 "content": "hi"}, token=app.token, ctype="text/plain")
    assert status == 415


def test_the_page_sets_the_cookie_from_the_token(server):
    app, port, *_ = server
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", f"/?token={app.token}", headers={"Host": f"127.0.0.1:{port}"})
    r = c.getresponse()
    r.read()
    assert r.status == 200 and app.token in (r.getheader("Set-Cookie") or "")
    assert call(port, "GET", "/")[0] == 401


# --- what it shows ---------------------------------------------------------------

def test_state_has_agents_models_presence_and_channels(server):
    app, port, *_ = server
    _, st = call(port, "GET", "/api/state?team=demo", token=app.token)
    assert [a["name"] for a in st["agents"]] == ["tpm", "coder", "qa"]
    assert st["agents"][1]["model"]["model"] == "flash"
    assert st["agents"][0]["presence"]["state"] == "offline"
    assert "general" in st["channels"] and st["author"] == "matt"


def test_posting_wakes_only_whom_it_mentions(server):
    app, port, td, _ = server
    _, r = call(port, "POST", "/api/post", {"team": "demo", "channel": "general",
                                            "content": "@coder look at allocate"}, token=app.token)
    assert r["woke"] == ["coder"]
    inboxes = {n: [json.loads(l) for l in (td / "inbox" / f"{n}.jsonl").read_text().splitlines()]
               for n in ("coder", "qa")}
    assert not inboxes["coder"][0].get("quiet") and inboxes["qa"][0]["quiet"]
    _, msgs = call(port, "GET", "/api/messages?team=demo&channel=general", token=app.token)
    [m] = msgs["messages"]
    assert m["author"] == "matt" and m["from"] == "user"


def test_threads_and_dms(server):
    app, port, td, _ = server
    _, root = call(port, "POST", "/api/post", {"team": "demo", "channel": "general",
                                               "content": "question for @qa"}, token=app.token)
    FileTransport("qa", {"team_dir": str(td)}).post("general", ["tpm", "coder"], "answer",
                                                    thread=root["id"])
    _, th = call(port, "GET", f"/api/messages?team=demo&thread={root['id']}", token=app.token)
    assert [m["content"] for m in th["messages"]] == ["question for @qa", "answer"]
    call(port, "POST", "/api/post", {"team": "demo", "to": "coder", "content": "hello"}, token=app.token)
    _, dm = call(port, "GET", "/api/messages?team=demo&dm=user,coder", token=app.token)
    assert [m["content"] for m in dm["messages"]] == ["hello"]


def test_channels_can_be_made_and_changed(server):
    app, port, *_ = server
    _, r = call(port, "POST", "/api/channel", {"team": "demo", "action": "create", "name": "billing",
                                               "members": ["coder", "qa"]}, token=app.token)
    assert r["members"] == ["coder", "qa"]
    status, err = call(port, "POST", "/api/channel", {"team": "demo", "action": "create",
                                                      "name": "billing"}, token=app.token)
    assert status == 400 and "already exists" in err["error"]


def test_the_model_can_be_changed_and_cleared(server):
    app, port, *_ = server
    call(port, "POST", "/api/model", {"team": "demo", "agent": "coder", "model": "opus",
                                      "until": "1d"}, token=app.token)
    _, st = call(port, "GET", "/api/state?team=demo", token=app.token)
    coder = st["agents"][1]["model"]
    assert coder["model"] == "opus" and coder["source"].startswith("override")
    call(port, "POST", "/api/model", {"team": "demo", "agent": "coder", "model": None}, token=app.token)
    _, st = call(port, "GET", "/api/state?team=demo", token=app.token)
    assert st["agents"][1]["model"]["model"] == "flash"


def test_artifacts_are_read_only_and_stay_inside_the_team(server):
    app, port, _, ws = server
    _, a = call(port, "GET", f"/api/artifact?team=demo&path={ws / 'report.md'}", token=app.token)
    assert a["kind"] == "markdown" and "allocate drops a cent" in a["content"]
    _, a = call(port, "GET", "/api/artifact?team=demo&path=/etc/passwd", token=app.token)
    assert "outside" in a["error"]
    _, a = call(port, "GET", f"/api/artifact?team=demo&path={ws}/../../../../etc/passwd", token=app.token)
    assert "outside" in a["error"]


def test_the_live_feed_carries_new_messages(server):
    app, port, td, _ = server
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", "/api/events?team=demo", headers={"Host": f"127.0.0.1:{port}", "X-Token": app.token})
    r = c.getresponse()
    assert r.getheader("Content-Type") == "text/event-stream"
    time.sleep(0.3)
    FileTransport("coder", {"team_dir": str(td)}).send("user", "done, see report.md")
    deadline = time.time() + 6
    got = b""
    while time.time() < deadline and b"done, see report.md" not in got:
        got += r.fp.read1(4096)
    assert b"done, see report.md" in got


def test_search(server):
    app, port, *_ = server
    call(port, "POST", "/api/post", {"team": "demo", "channel": "general",
                                     "content": "the kingfisher invoice"}, token=app.token)
    _, r = call(port, "GET", "/api/search?team=demo&q=kingfisher", token=app.token)
    assert r["hits"] and r["hits"][0]["type"] == "message"


def test_wiki(server):
    app, port, td, _ = server
    (td / "NORMS.md").write_text("## Review\nAlways run the proof.\n")
    mem = td.parent / "agents" / "qa" / "memory"
    mem.mkdir(parents=True)
    (mem / "proofs.md").write_text("run proofs before approving")
    _, w = call(port, "GET", "/api/wiki?team=demo", token=app.token)
    assert "Always run the proof" in w["norms"]
    assert w["memories"]["qa"][0]["name"] == "proofs"


def test_activity_shows_one_agents_events(server):
    app, port, td, _ = server
    with (td / "events.jsonl").open("a") as f:
        f.write(json.dumps({"ts": "2026-10-18 10:00:00", "event": "tool_call", "agent": "coder",
                            "tool": "run_command", "args": {"CommandLine": "pytest"}}) + "\n")
        f.write(json.dumps({"ts": "2026-10-18 10:00:05", "event": "turn", "agent": "qa"}) + "\n")
    _, r = call(port, "GET", "/api/activity?team=demo&agent=coder", token=app.token)
    assert [e["tool"] for e in r["events"]] == ["run_command"]

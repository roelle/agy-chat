"""agy-chat's server: the record over HTTP, operator actions, and a live feed.

    python -m agychat                       # every team under ~/agy-teams
    python -m agychat --teams-root DIR      # or another root
    python -m agychat --team-dir PATH       # or a team directory directly

Binds to 127.0.0.1 and prints a URL with a one-time token; the browser keeps
it as a cookie. Every API call needs it, every state-changing call must be
JSON (which a cross-site form cannot send), and the Host header must be the
loopback address -- this server can post as you to a team of agents with
shells, so a web page you happen to have open must not be able to.

Reads go through agyteam.record, changes through agyteam.actions; nothing
here parses or writes the team's files itself.
"""
import argparse
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from agyteam import actions
from agyteam.record import Feed, Record

from .teams import Team, discover

STATIC = Path(__file__).resolve().parent / "static"
COOKIE = "agychat"


class App:
    def __init__(self, teams_root: Path | None, team_dirs: list[Path], author: str):
        self.teams_root = teams_root
        self.team_dirs = team_dirs
        self.author = author
        self.token = secrets.token_urlsafe(18)
        self._teams: dict[str, Team] = {}
        self.refresh()

    def refresh(self) -> dict[str, Team]:
        self._teams = discover(self.teams_root, self.team_dirs)
        return self._teams

    def team(self, name: str) -> Team:
        t = self._teams.get(name) or self.refresh().get(name)
        if t is None:
            raise LookupError(f"no team {name!r}")
        return t

    # --- reads ------------------------------------------------------------------

    def teams(self) -> list[dict]:
        out = []
        for name, t in self.refresh().items():
            rec = Record(t.dir)
            out.append({"name": name, "dir": str(t.dir), "agents": rec.agents(),
                        "supervisor": bool(rec.supervisor()), "stopped": rec.stopped()})
        return out

    def state(self, team: str) -> dict:
        t = self.team(team)
        rec = Record(t.dir)
        presence = rec.presence()
        models = rec.models()
        agents = []
        for a in rec.roster().get("agents", []):
            n = a["name"]
            agents.append({"name": n, "role": a.get("role", ""),
                           "presence": presence.get(n, {}), "model": models.get(n, {})})
        reviews = rec.reviews()
        reviewed = {r.get("task_id") for r in reviews
                    if r.get("verdict") in ("approved", "waived") and r.get("task_id")}
        tasks = []
        for task in rec.tasks()[:200]:
            tasks.append({k: task.get(k) for k in (
                "id", "project", "title", "owner", "status", "note", "check_after", "until",
                "requires_review", "updated_at", "created_by", "evidence")}
                | {"reviewed": task.get("id") in reviewed})
        sup = rec.supervisor()
        return {"team": team, "author": self.author, "agents": agents,
                "channels": rec.channels(), "conversations": rec.conversations(),
                "tasks": tasks, "supervisor": sup, "stopped": rec.stopped(),
                "reply_counts": rec.reply_counts()}

    def messages(self, team: str, q: dict) -> dict:
        rec = Record(self.team(team).dir)
        if q.get("thread"):
            return {"messages": rec.thread(q["thread"])}
        if q.get("channel"):
            rows = rec.messages(channel=q["channel"])
        elif q.get("dm"):
            a, _, b = q["dm"].partition(",")
            b = b or "user"
            rows = rec.messages(dm=(a, b), include_plumbing="supervisor" in (a, b))
        else:
            rows = []
        return {"messages": rows[-int(q.get("limit") or 500):],
                "reply_counts": rec.reply_counts()}

    # --- changes ------------------------------------------------------------------

    def post(self, team: str, body: dict) -> dict:
        t = self.team(team)
        content = (body.get("content") or "").strip()
        kind = body.get("kind") or "work"
        if body.get("channel"):
            return actions.post(t.dir, body["channel"], content, author=self.author,
                                thread=body.get("thread") or None, kind=kind)
        if body.get("to"):
            return {"result": actions.dm(t.dir, body["to"], content, author=self.author,
                                         thread=body.get("thread") or None, kind=kind)}
        raise actions.OperatorError("say where: a channel or an agent")

    def channel(self, team: str, body: dict) -> dict:
        t = self.team(team)
        action = body.get("action")
        if action == "create":
            return actions.create_channel(t.dir, body.get("name", ""), body.get("members") or [],
                                          body.get("topic", ""))
        if action == "members":
            return {"members": actions.set_members(t.dir, body["name"], body.get("add") or [],
                                                   body.get("remove") or [])}
        raise actions.OperatorError(f"unknown channel action {action!r}")

    def model(self, team: str, body: dict) -> dict:
        t = self.team(team)
        if not body.get("model"):
            return actions.clear_model(t.dir, body["agent"], by=self.author)
        return actions.set_model(t.dir, body["agent"], body["model"],
                                 until=body.get("until") or None,
                                 reason=body.get("reason") or "set from agy-chat", by=self.author)

    def supervisor(self, team: str, body: dict) -> dict:
        t = self.team(team)
        if body.get("action") == "start":
            return t.start_supervisor()
        if body.get("action") == "stop":
            return t.stop_supervisor()
        raise actions.OperatorError("action is start or stop")


class Handler(BaseHTTPRequestHandler):
    app: App = None                  # set by serve()
    server_version = "agy-chat/0.1"

    def log_message(self, fmt, *args):  # quiet; errors still go to stderr
        pass

    # --- plumbing ------------------------------------------------------------------

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200):
        self._send(status, json.dumps(obj, default=str).encode(), "application/json")

    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost", "::1")

    def _authed(self) -> bool:
        c = SimpleCookie(self.headers.get("Cookie") or "")
        return (COOKIE in c and secrets.compare_digest(c[COOKIE].value, self.app.token)) or \
            secrets.compare_digest(self.headers.get("X-Token", ""), self.app.token)

    def _query(self) -> tuple[str, dict]:
        u = urlparse(self.path)
        return u.path, {k: v[-1] for k, v in parse_qs(u.query).items()}

    # --- routes ----------------------------------------------------------------------

    def do_GET(self):
        if not self._local():
            return self._send(403, b"local only", "text/plain")
        path, q = self._query()
        if path in ("/", "/index.html", "/wiki"):
            extra = {}
            if q.get("token") and secrets.compare_digest(q["token"], self.app.token):
                extra["Set-Cookie"] = f"{COOKIE}={self.app.token}; Path=/; HttpOnly; SameSite=Strict"
            elif not self._authed():
                return self._send(401, b"Open the URL agy-chat printed (it carries the token).",
                                  "text/plain")
            page = "wiki.html" if path == "/wiki" else "index.html"
            return self._send(200, (STATIC / page).read_bytes(), "text/html; charset=utf-8", extra)
        if path.startswith("/static/"):
            f = (STATIC / path[len("/static/"):]).resolve()
            if STATIC not in f.parents or not f.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            return self._send(200, f.read_bytes(), ctype)
        if not path.startswith("/api/"):
            return self._send(404, b"not found", "text/plain")
        if not self._authed():
            return self._json({"error": "not authorised"}, 401)
        try:
            if path == "/api/teams":
                return self._json({"teams": self.app.teams()})
            team = q.get("team", "")
            if path == "/api/state":
                return self._json(self.app.state(team))
            if path == "/api/messages":
                return self._json(self.app.messages(team, q))
            if path == "/api/artifact":
                return self._json(self.app.team(team).read_artifact(q.get("path", "")))
            if path == "/api/search":
                return self._json({"hits": Record(self.app.team(team).dir).search(q.get("q", ""))})
            if path == "/api/activity":
                rows = [e for e in Record(self.app.team(team).dir).events()
                        if e.get("agent") == q.get("agent")]
                return self._json({"events": rows[-120:]})
            if path == "/api/wiki":
                t = self.app.team(team)
                return self._json({"norms": Record(t.dir).norms(), "memories": t.memories()})
            if path == "/api/events":
                return self._events(team)
        except LookupError as e:
            return self._json({"error": str(e)}, 404)
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        return self._json({"error": "unknown endpoint"}, 404)

    def do_POST(self):
        if not self._local() or not self._authed():
            return self._json({"error": "not authorised"}, 401)
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self._json({"error": "send JSON"}, 415)
        path, q = self._query()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 1_000_000)) or b"{}")
            team = body.get("team") or q.get("team", "")
            route = {"/api/post": self.app.post, "/api/channel": self.app.channel,
                     "/api/model": self.app.model, "/api/supervisor": self.app.supervisor}
            fn = route.get(path)
            if fn is None:
                return self._json({"error": "unknown endpoint"}, 404)
            return self._json(fn(team, body))
        except actions.OperatorError as e:
            return self._json({"error": str(e)}, 400)
        except LookupError as e:
            return self._json({"error": str(e)}, 404)
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    def _events(self, team: str):
        """Server-sent events: each row appended to the record, as it lands."""
        t = self.app.team(team)
        feed = Feed(t.dir)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last_beat = 0.0
        try:
            while True:
                items = feed.poll()
                for it in items:
                    self.wfile.write(b"data: " + json.dumps(it, default=str).encode() + b"\n\n")
                now = time.monotonic()
                if now - last_beat > 15:
                    self.wfile.write(b": keepalive\n\n")
                    last_beat = now
                self.wfile.flush()
                time.sleep(0.7)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def serve(app: App, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    Handler.app = app
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    return httpd


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="agy-chat", description=__doc__.split("\n\n")[0])
    ap.add_argument("--teams-root", default=os.environ.get("AGYTEAM_TEAMS_ROOT", "~/agy-teams"))
    ap.add_argument("--team-dir", action="append", default=[],
                    help="a team directory to show (repeatable)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--author", default=os.environ.get("USER") or "operator",
                    help="your name on what you post")
    a = ap.parse_args(argv)
    if os.environ.get("AGYTEAM_AGENT"):
        sys.exit("agy-chat speaks as the operator; it will not run inside an agent's session")
    app = App(Path(a.teams_root).expanduser(), [Path(p) for p in a.team_dir], a.author)
    httpd = serve(app, "127.0.0.1", a.port)
    names = ", ".join(app.refresh()) or "none found"
    print(f"agy-chat: {len(app.refresh())} team(s) ({names})\n"
          f"open  http://127.0.0.1:{a.port}/?token={app.token}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

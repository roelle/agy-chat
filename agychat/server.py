"""agy-chat's server: the record over HTTP, operator actions, and a live feed.

    python -m agychat                       # every team under ~/agy-teams
    python -m agychat --teams-root DIR      # or another root
    python -m agychat --team-dir PATH       # or a team directory directly

Binds to 127.0.0.1 (or --host) and prints a URL with a one-time token
(--open also opens it); the browser keeps it as a cookie. Every API call needs it, every state-changing call must be
JSON (which a cross-site form cannot send), and the Host header must be a
name this server answers to (see Handler._local) -- this server can post as
you to a team of agents with shells, so a web page you happen to have open
must not be able to.

Reads go through agyteam.record, changes through agyteam.actions; nothing
here parses or writes the team's files itself.
"""
import argparse
import ipaddress
import json
import mimetypes
import os
import secrets
import socket
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
        self.host = "127.0.0.1"         # what serve() bound; the Host check reads it
        # A restart for an update passes the token on, so open tabs stay
        # signed in. Taken out of the environment at once: supervisors this
        # app starts inherit it, and an agent with a shell must not be able
        # to post as the operator.
        self.token = os.environ.pop("AGYCHAT_TOKEN", "") or secrets.token_urlsafe(18)
        self._teams: dict[str, Team] = {}
        self.updating: dict = {"state": "idle", "log": []}
        self.argv: list[str] = []        # main's arguments, for a restart in place
        self.reexec = self._reexec
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
            agents.append({"name": n, "alias": a.get("alias"), "role": a.get("role", ""),
                           "presence": presence.get(n, {}), "model": models.get(n, {})})
        sup = rec.supervisor()
        # Where an agent last mentioned the operator, keyed as the client keys
        # its views ("c:<channel>"), so a mention made while nobody was
        # looking is still flagged.
        mentions = {}
        for m in rec.bus():
            if m.get("channel") and m.get("from") != "user" and "user" in (m.get("mentions") or []):
                mentions[f"c:{m['channel']}"] = m.get("ts")
        return {"team": team, "author": self.author, "operator": rec.operator(),
                "mentions_of_user": mentions,
                "agents": agents, "channels": rec.channels(),
                "conversations": rec.conversations(), "tasks": self.tasks(team)[:300],
                "supervisor": sup, "stopped": rec.stopped(),
                "reply_counts": rec.reply_counts()}

    TASK_FIELDS = ("id", "project", "title", "owner", "status", "note", "check_after", "until",
                   "requires_review", "updated_at", "created_at", "created_by", "evidence",
                   "channel", "rank", "deadline", "collaborators")

    def tasks(self, team: str) -> list[dict]:
        rec = Record(self.team(team).dir)
        reviewed = {r.get("task_id") for r in rec.reviews()
                    if r.get("verdict") in ("approved", "waived") and r.get("task_id")}
        return [{k: t.get(k) for k in self.TASK_FIELDS} | {"reviewed": t.get("id") in reviewed}
                for t in rec.tasks()]

    def task(self, team: str, task_id: str) -> dict:
        """One task with everything about it: its log, its messages, its reviews."""
        from agyteam import tasks as tasks_lib
        t = self.team(team)
        rec = Record(t.dir)
        row = next((x for x in self.tasks(team) if x["id"] == task_id), None)
        if row is None:
            raise LookupError(f"no task {task_id}")
        return {"task": row,
                "history": [e for e in tasks_lib.read(t.dir) if e.get("id") == task_id],
                "messages": [m for m in rec.bus() if m.get("task_id") == task_id][-200:],
                "reviews": [r for r in rec.reviews() if r.get("task_id") == task_id]}

    def messages(self, team: str, q: dict) -> dict:
        rec = Record(self.team(team).dir)
        if q.get("thread"):
            return {"messages": rec.thread(q["thread"])}
        if q.get("channel"):
            # A deleted channel's history stays in the record, out of sight.
            gone = (rec.channels().get(q["channel"]) or {}).get("deleted")
            rows = [] if gone else rec.messages(channel=q["channel"])
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
                                          body.get("topic", ""),
                                          everyone=bool(body.get("everyone")))
        if action == "members":
            return {"members": actions.set_members(t.dir, body["name"], body.get("add") or [],
                                                   body.get("remove") or [],
                                                   everyone=body.get("everyone"))}
        if action == "topic":
            actions.set_topic(t.dir, body["name"], body.get("topic") or "")
            return {"ok": True}
        fn = {"archive": actions.archive_channel, "delete": actions.delete_channel,
              "restore": actions.restore_channel}.get(action)
        if fn:
            return fn(t.dir, body["name"])
        raise actions.OperatorError(f"unknown channel action {action!r}")

    def task_action(self, team: str, body: dict) -> dict:
        t = self.team(team)
        action = body.get("action")
        if action == "create":
            return actions.create_task(
                t.dir, body.get("project") or "", body.get("title") or "",
                owner=body.get("owner") or None, note=body.get("note") or "",
                channel=body.get("channel") or None, status=body.get("status") or None,
                deadline=body.get("deadline") or None,
                requires_review=bool(body.get("requires_review")), rank=body.get("rank"))
        if action == "update":
            fields = ("status", "owner", "title", "project", "note", "channel", "deadline", "rank")
            return actions.update_task(t.dir, body["id"],
                                       **{k: body[k] for k in fields if k in body})
        if action == "waive":
            return actions.waive_review(t.dir, body["id"], by=self.author,
                                        reason=body.get("reason") or "waived on the board")
        raise actions.OperatorError(f"unknown task action {action!r}")

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
        if body.get("action") == "restart":
            return actions.restart(t.dir, now=bool(body.get("now")), by=self.author)
        raise actions.OperatorError("action is start, stop or restart")

    # --- admin --------------------------------------------------------------------

    def admin(self, team: str) -> dict:
        t = self.team(team)
        roster = t.roster()
        return {"agents": [{k: a.get(k) for k in ("name", *actions.AGENT_FIELDS) if k in a}
                           for a in roster.get("agents", [])],
                "fields": list(actions.AGENT_FIELDS),
                "memory_model": roster.get("memory_model"),
                "norms": actions.norms(t.dir)}

    def agent(self, team: str, body: dict) -> dict:
        t = self.team(team)
        action, name = body.get("action"), body.get("name") or ""
        fields = {k: body[k] for k in actions.AGENT_FIELDS if k in body and k != "role"}
        if action == "add":
            return actions.add_agent(t.dir, name, role=body.get("role") or "",
                                     channels="all" if body.get("all_channels", True) else None,
                                     **fields)
        if action == "update":
            if "role" in body:
                fields["role"] = body["role"]
            return actions.update_agent(t.dir, name, **fields)
        if action == "remove":
            return actions.remove_agent(t.dir, name)
        raise actions.OperatorError("action is add, update or remove")

    def norms(self, team: str, body: dict) -> dict:
        return actions.set_norms(self.team(team).dir, body.get("text") or "", by=self.author)

    def memories(self, team: str, agent: str) -> dict:
        """One agent's memories with their history, its archive, and its
        recent memory reviews."""
        t = self.team(team)
        rec = Record(t.dir)
        content = {m["name"]: m["content"] for m in actions.memories(t.dir, agent)}
        stats = rec.memory_stats(agent)
        from agyteam.memory import extract_provenance
        for m in stats:
            _, why, body = extract_provenance(content.get(m["name"], ""))
            m["content"], m["why"] = body, why or ""
        reviews = [e for e in rec.events("memory_review") if e.get("agent") == agent][-5:]
        queued = any(r.get("action") == "review" and r.get("agent") == agent
                     for r in _distill_queue().pending(t.dir))
        return {"memories": stats, "archived": rec.memory_archive(agent),
                "reviews": list(reversed(reviews)), "review_queued": queued}

    def memory(self, team: str, body: dict) -> dict:
        t = self.team(team)
        if body.get("action") == "restore":
            return actions.restore_memory(t.dir, body.get("agent") or "", body.get("id") or "",
                                          by=self.author)
        if body.get("action") == "review":
            return actions.review_memory(t.dir, body.get("agent") or "", by=self.author)
        if body.get("action") == "save":
            return actions.save_memory(t.dir, body.get("agent") or "", body.get("name") or "",
                                       body.get("content") or "", body.get("description") or "",
                                       by=self.author)
        if body.get("action") == "delete":
            return actions.delete_memory(t.dir, body.get("agent") or "", body.get("name") or "",
                                         by=self.author)
        raise actions.OperatorError("action is save, delete, restore or review")

    # --- update -------------------------------------------------------------------

    def versions(self) -> dict:
        from agyteam import __version__ as agyteam_version
        from . import __version__
        teams = []
        for name, t in self.refresh().items():
            beat = Record(t.dir).supervisor() or {}
            teams.append({"name": name, "running": bool(beat), "version": beat.get("version"),
                          "restartable": bool(beat.get("restartable")),
                          "draining": bool(beat.get("draining")),
                          "inflight": beat.get("inflight") or [], "started": beat.get("started")})
        return {"agychat": __version__, "agyteam": agyteam_version, "teams": teams,
                "update": {k: v for k, v in self.updating.items() if k != "log"},
                "log": self.updating.get("log", [])[-200:]}

    def update(self, team: str, body: dict) -> dict:
        from . import update as up
        if body.get("action") == "check":
            from agyteam import update as atu
            try:
                mine = up.plan_self()
            except Exception as e:
                mine = {"error": str(e)}
            theirs = up._agyteam(["--check"], lambda line: None).get("plan")
            return {"agychat": mine, "agyteam": theirs,
                    "agyteam_shares_this_env": up.agyteam_shares_this_env(),
                    "agyteam_checkout": str(atu.checkout() or "")}
        if body.get("action") != "run":
            raise actions.OperatorError("action is check or run")
        if self.updating.get("state") == "running":
            raise actions.OperatorError("an update is already running")
        self.updating = {"state": "running", "log": [],
                         "started": time.strftime("%Y-%m-%d %H:%M:%S")}
        threading.Thread(target=self._run_update, args=(bool(body.get("now")),),
                         daemon=True).start()
        return {"started": True}

    def _run_update(self, now: bool) -> None:
        from . import update as up
        log = self.updating["log"].append
        try:
            out = up.run([t.dir for t in self.refresh().values()], now=now, log=log)
        except Exception as e:
            out = {"error": f"{type(e).__name__}: {e}"}
        if out.get("error"):
            log(f"error: {out['error']}")
            self.updating.update(state="error", error=out["error"])
            return
        log("restarting agy-chat…")
        self.updating.update(state="restarting", result=out)
        time.sleep(1.5)                  # let the page see "restarting" first
        self.reexec()

    def _reexec(self) -> None:
        """Replace this process with a fresh one on the new code: same
        arguments (less --open), same token, same port."""
        os.environ["AGYCHAT_TOKEN"] = self.token
        sys.stdout.flush()
        sys.stderr.flush()
        args = [a for a in self.argv if a not in ("--open", "--no-open")]
        os.execv(sys.executable, [sys.executable, "-m", "agychat", *args])


def _distill_queue():
    from agyteam import distill_queue
    return distill_queue


class Handler(BaseHTTPRequestHandler):
    app: App = None                  # set by serve()
    server_version = "agy-chat"

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
        """Is the Host header one this server answers to?

        The check stops DNS rebinding: a page on evil.example whose name is
        made to resolve here sends Host: evil.example. Loopback names always
        pass; so does the name given to --host. Bound beyond loopback, so
        does any IP literal, which no rebinding attack can produce.
        """
        raw = self.headers.get("Host") or ""
        host = raw[1:raw.index("]")] if raw.startswith("[") and "]" in raw \
            else raw.rsplit(":", 1)[0]
        host = host.lower()
        if host in ("127.0.0.1", "localhost", "::1") or host == self.app.host.lower():
            return True
        if is_loopback(self.app.host):
            return False
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

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
        if path in ("/", "/index.html", "/wiki", "/board", "/admin"):
            extra = {}
            if q.get("token") and secrets.compare_digest(q["token"], self.app.token):
                extra["Set-Cookie"] = f"{COOKIE}={self.app.token}; Path=/; HttpOnly; SameSite=Strict"
            elif not self._authed():
                return self._send(401, b"Open the URL agy-chat printed (it carries the token).",
                                  "text/plain")
            page = {"/wiki": "wiki.html", "/board": "board.html",
                    "/admin": "admin.html"}.get(path, "index.html")
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
            if path == "/api/tasks":
                return self._json({"tasks": self.app.tasks(team)})
            if path == "/api/task":
                return self._json(self.app.task(team, q.get("id", "")))
            if path == "/api/search":
                return self._json({"hits": Record(self.app.team(team).dir).search(q.get("q", ""))})
            if path == "/api/models":
                # The team's runner -- its roster's supervisor block, as
                # the supervisor Start launches would use -- not this app's
                # environment, which named no runner and listed nothing.
                from agyteam import runner as runner_lib
                td = self.app.team(team).dir
                cls = runner_lib.runner_class(team_dir=td)
                return self._json({"runner": getattr(cls, "label", None),
                                   "models": runner_lib.list_models(team_dir=td)})
            if path == "/api/activity":
                rows = [e for e in Record(self.app.team(team).dir).events()
                        if e.get("agent") == q.get("agent")]
                return self._json({"events": rows[-120:]})
            if path == "/api/wiki":
                t = self.app.team(team)
                return self._json({"norms": Record(t.dir).norms(), "memories": t.memories()})
            if path == "/api/events":
                return self._events(team)
            if path == "/api/admin":
                return self._json(self.app.admin(team))
            if path == "/api/memories":
                return self._json(self.app.memories(team, q.get("agent", "")))
            if path == "/api/norm_candidates":
                return self._json({"groups": Record(self.app.team(team).dir).norm_candidates()})
            if path == "/api/versions":
                return self._json(self.app.versions())
        except actions.OperatorError as e:
            return self._json({"error": str(e)}, 400)
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
                     "/api/model": self.app.model, "/api/supervisor": self.app.supervisor,
                     "/api/task": self.app.task_action, "/api/agent": self.app.agent,
                     "/api/norms": self.app.norms, "/api/memory": self.app.memory,
                     "/api/update": self.app.update}
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


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def serve(app: App, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    Handler.app = app
    app.host = host
    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

    httpd = Server((host, port), Handler)
    httpd.daemon_threads = True
    return httpd


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="agy-chat", description=__doc__.split("\n\n")[0])
    from . import __version__
    from agyteam import __version__ as agyteam_version
    ap.add_argument("--version", action="version",
                    version=f"agy-chat {__version__} (agyteam {agyteam_version})")
    ap.add_argument("--teams-root", default=os.environ.get("AGYTEAM_TEAMS_ROOT", "~/agy-teams"))
    ap.add_argument("--team-dir", action="append", default=[],
                    help="a team directory to show (repeatable)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="address to listen on (default 127.0.0.1). Anything "
                         "beyond loopback is plain HTTP: anyone who can reach "
                         "it and has the printed URL can post as you")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action=argparse.BooleanOptionalAction, default=False,
                    help="open the URL in a browser (default: just print it)")
    ap.add_argument("--author", default=os.environ.get("USER") or "operator",
                    help="your name on what you post")
    a = ap.parse_args(argv)
    if os.environ.get("AGYTEAM_AGENT"):
        sys.exit("agy-chat speaks as the operator; it will not run inside an agent's session")
    app = App(Path(a.teams_root).expanduser(), [Path(p) for p in a.team_dir], a.author)
    app.argv = list(argv if argv is not None else sys.argv[1:])
    httpd = serve(app, a.host, a.port)
    names = ", ".join(app.refresh()) or "none found"
    shown = "127.0.0.1" if a.host in ("0.0.0.0", "::", "") else a.host
    url = f"http://{'[' + shown + ']' if ':' in shown else shown}:{httpd.server_address[1]}/?token={app.token}"
    print(f"agy-chat: {len(app.refresh())} team(s) ({names})\n"
          f"open  {url}", flush=True)
    if not is_loopback(a.host):
        print(f"agy-chat: listening on {a.host}, beyond this machine, over plain "
              f"HTTP. Anyone who can reach it and has that URL can post as "
              f"{a.author} to agents with shells.", file=sys.stderr, flush=True)
    if a.open:
        import webbrowser
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

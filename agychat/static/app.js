/* agy-chat front end. No framework, no build: state in one object, DOM by hand. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const QUIET = new Set(["ack", "fyi", "status"]);
const LOUD = new Set(["deliverable", "question", "blocker", "review", "reminder"]);
const S = {
  teams: [], team: null, state: null, view: null, messages: [], replyCounts: {},
  thread: null, events: null, seen: load("agychat.seen", {}), latest: {}, atMe: {},
};
const TERMINAL = new Set(["done", "failed", "cancelled"]);

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

async function api(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" },
                       body: JSON.stringify({ team: S.team, ...body }) } : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const q = (o) => new URLSearchParams({ team: S.team, ...o }).toString();

function toast(text, err) {
  const t = $("#toast"); t.textContent = text; t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 2500);
}

// --- rendering helpers ----------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLORS = ["#3a6ff7", "#19a463", "#d4891a", "#8a5cf6", "#d64545", "#2b8fd6", "#c2418f", "#5b8a72"];
function color(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function hhmm(ts) { return (ts || "").slice(11, 16); }

// What people are called: an agent's alias, else its name; the operator's
// roster name for "user". Every name shown goes through here.
function agentOf(n) { return (S.state?.agents || []).find((a) => a.name === n); }
function nameOf(n) {
  if (n === "user") return S.state?.operator?.name || S.state?.author || "you";
  return agentOf(n)?.alias || n;
}
function myHandles() {
  return new Set(["user", ...(S.state?.operator?.handles || [])].map((h) => h.toLowerCase()));
}
function boardURL(taskId) {
  return `/board?team=${encodeURIComponent(S.team)}${taskId ? "#task=" + encodeURIComponent(taskId) : ""}`;
}

function inline(text) {
  // text is already escaped
  const mine = myHandles();
  return text
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])((?:~|\/)[\w.~\-]+(?:\/[\w.\-]+)+\/?)/g,
             (_, pre, p) => `${pre}<span class="pill-file" data-path="${p}">${p}</span>`)
    .replace(/(^|[^\w@])@([A-Za-z0-9](?:[\w-]|\.(?=\w))*)/g, (_, pre, n) => `${pre}<span class="mention${mine.has(n.toLowerCase()) ? " me" : ""}">@${n}</span>`)
    .replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

function markdown(src) {
  const out = []; const lines = esc(src).split("\n"); let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${buf.join("\n")}</code></pre>`); continue;
    }
    if (/^\s*[-*] /.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*] /, ""))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^#{1,4} /.test(l)) { out.push(`<p><strong>${inline(l.replace(/^#+ /, ""))}</strong></p>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*[-*] /.test(lines[i])) para.push(inline(lines[i++]));
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

function sender(m) {
  if (m.from !== "user") return nameOf(m.from);
  const op = S.state?.operator?.name;
  return op && (!m.author || m.author.toLowerCase() === op.toLowerCase()) ? op : (m.author || nameOf("user"));
}
const mentionsMe = (m) => m.from !== "user" && (m.mentions || []).includes("user");

function msgHTML(m, opts = {}) {
  const kind = m.kind || "work";
  const quiet = QUIET.has(kind);
  const who = sender(m);
  const badge = kind !== "work" ? `<span class="badge ${quiet ? "quiet" : kind}">${esc(kind)}</span>` : "";
  const task = m.task_id ? `<a class="badge quiet" href="${boardURL(m.task_id)}" target="agy-board" title="Open on the board">${esc(m.task_id)}</a>` : "";
  const to = opts.showTo && m.to && !String(m.to).startsWith("#") ? ` <span class="when">→ ${esc(nameOf(m.to))}</span>` : "";
  const n = S.replyCounts[m.id] || 0;
  const replies = !opts.inThread && n ? `<div class="replies" data-thread="${esc(m.id)}">${n} repl${n === 1 ? "y" : "ies"}</div>` :
                  !opts.inThread && m.id ? `<div class="replies" style="opacity:.0" onmouseover="this.style.opacity=.8" onmouseout="this.style.opacity=0"><span data-thread="${esc(m.id)}">reply in thread</span><span class="mk-task" data-mktask="${esc(m.id)}">make a task</span></div>` : "";
  return `<div class="msg ${quiet ? "quiet" : ""} ${LOUD.has(kind) ? kind : ""} ${mentionsMe(m) ? "mentions-me" : ""}" data-id="${esc(m.id || "")}">
    <div class="avatar" style="background:${color(who)}">${esc(who[0] || "?").toUpperCase()}</div>
    <div><div><span class="who">${esc(who)}</span>${to}<span class="when" title="${esc(m.ts)}">${hhmm(m.ts)}</span>${badge}${task}</div>
    <div class="body">${markdown(m.content || "")}</div>${replies}</div></div>`;
}

// --- views ------------------------------------------------------------------------

function viewKey(v) { return v.type === "channel" ? `c:${v.id}` : `d:${[...v.pair].sort().join(",")}`; }
function keyOf(m) {
  if (m.channel) return `c:${m.channel}`;
  if (m.from && m.to) return `d:${[m.from, m.to].sort().join(",")}`;
  return null;
}

async function loadTeams() {
  const { teams } = await api("/api/teams");
  S.teams = teams;
  const sel = $("#team");
  sel.innerHTML = teams.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}${t.supervisor ? " ●" : ""}</option>`).join("");
  if (!teams.length) { $("#messages").innerHTML = `<div class="empty">No teams found. Start agy-chat with --teams-root or --team-dir.</div>`; return; }
  const asked = new URLSearchParams(location.search).get("team");
  const want = asked || load("agychat.team", null);
  S.team = teams.some((t) => t.name === want) ? want : teams[0].name;
  sel.value = S.team;
  await openTeam();
}

async function openTeam() {
  save("agychat.team", S.team);
  $("#wiki-link").href = `/wiki?team=${encodeURIComponent(S.team)}`;
  $("#board-link").href = boardURL();
  $("#admin-link").href = `/admin?team=${encodeURIComponent(S.team)}`;
  await refreshState();
  const v = linkedView() || load(`agychat.view.${S.team}`, null);
  const chans = Object.keys(S.state.channels || {});
  const open = chans.filter((c) => !S.state.channels[c].archived);
  await openView(v && (v.type !== "channel" || chans.includes(v.id)) ? v : { type: "channel", id: open[0] || chans[0] || "general" });
  listen();
}

// The board links here as /?team=T#channel=billing or #dm=coder.
function linkedView() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("channel")) return { type: "channel", id: h.get("channel") };
  if (h.get("dm")) return { type: "dm", pair: ["user", h.get("dm")] };
  return null;
}
window.addEventListener("hashchange", () => { const v = linkedView(); if (v && S.state) openView(v); });

async function refreshState() {
  S.state = await api(`/api/state?${q({})}`);
  S.replyCounts = S.state.reply_counts || {};
  // Mentions of you since you last looked, not only the ones that arrive live.
  for (const [k, ts] of Object.entries(S.state.mentions_of_user || {}))
    if (ts > (S.seen[`${S.team}|${k}`] || "") && !(S.view && viewKey(S.view) === k)) S.atMe[k] = true;
  $("#me").textContent = `posting as ${S.state.author}`;
  renderSidebar(); renderAgents(); renderTasks(); renderSupervisor();
  if (S.view) renderViewTasks();
}

function renderSupervisor() {
  const st = S.state; const pill = $("#sup-pill");
  if (st.supervisor && st.supervisor.draining) {
    const b = st.supervisor;
    pill.textContent = `restarting: waiting for ${(b.inflight || []).join(", ") || "the restart"}`;
    pill.title = "No new turns start; mail keeps queuing. The supervisor restarts on the installed code when these turns finish.";
    pill.className = "pill";
  }
  else if (st.supervisor) {
    const b = st.supervisor, src = b.source || {};
    pill.textContent = `running (${b.mode || "pid " + b.pid})` + (b.runner ? ` · ${b.runner}` : "") + (b.manager ? ` · manager ${b.manager}` : "");
    // Where the runner came from: "default" on a team that needs another
    // runner is the misconfiguration the roster's supervisor block fixes.
    pill.title = b.runner ? `runner ${b.runner_class || b.runner} (from ${src.runner || "?"}); manager ${b.manager || "none"}`
      + ` (${src.manager === "roster" ? "from the roster" : "detected from roles"}); pid ${b.pid}` : `pid ${b.pid}`;
    pill.className = "pill ok";
  }
  else if (st.stopped) { pill.textContent = `stopped: ${st.stopped}`.slice(0, 60); pill.className = "pill bad"; }
  else { pill.textContent = "no supervisor: nothing will wake"; pill.className = "pill bad"; }
  $("#sup-start").classList.toggle("hidden", !!st.supervisor);
  $("#sup-stop").classList.toggle("hidden", !st.supervisor);
  $("#sup-restart").classList.toggle("hidden", !st.supervisor || !!st.supervisor.draining);
}

function navItem(v, label, extra = "", opts) {
  const k = viewKey(v); const active = S.view && viewKey(S.view) === k;
  const unread = (S.latest[k] || "") > (S.seen[`${S.team}|${k}`] || "") && !active;
  const at = S.atMe[k] && !active ? `<span class="at" title="mentions you">@</span>` : "";
  return `<li class="${active ? "active" : ""} ${unread ? "unread" : ""} ${opts?.cls || ""}" data-view='${esc(JSON.stringify(v))}'>${label}${at}${extra}</li>`;
}

function renderSidebar() {
  const st = S.state;
  const chans = Object.entries(st.channels || {}).sort();
  const open = chans.filter(([, c]) => !c.archived);
  const shut = chans.filter(([, c]) => c.archived);
  $("#channels").innerHTML = open.map(([n, c]) =>
    navItem({ type: "channel", id: n }, `# ${esc(n)}`, `<span class="count">${(c.members || []).length}</span>`)).join("");
  $("#archived-head").classList.toggle("hidden", !shut.length);
  $("#archived-count").textContent = shut.length ? `(${shut.length})` : "";
  const showShut = load("agychat.showArchived", false);
  $("#archived-toggle").firstChild.textContent = (showShut ? "▾" : "▸") + " Archived ";
  $("#archived").classList.toggle("hidden", !showShut || !shut.length);
  $("#archived").innerHTML = shut.map(([n, c]) =>
    navItem({ type: "channel", id: n }, `# ${esc(n)}`, c.deleted ? `<span class="count">deleted</span>` : "",
            { cls: c.deleted ? "deleted" : "" })).join("");
  const pres = Object.fromEntries(st.agents.map((a) => [a.name, a.presence.state || "offline"]));
  $("#dms").innerHTML = st.agents.map((a) =>
    navItem({ type: "dm", pair: ["user", a.name] }, `<span class="dot ${pres[a.name]}"></span>${esc(nameOf(a.name))}`)).join("")
    + navItem({ type: "dm", pair: ["supervisor", "user"] }, `<span class="dot offline"></span>notices`);
  const pairs = (st.conversations || []).filter((p) => !p.includes("user") && !p.includes("supervisor"));
  $("#pairs-head").classList.toggle("hidden", !pairs.length);
  $("#pairs").innerHTML = pairs.map((p) => navItem({ type: "dm", pair: p }, `${esc(nameOf(p[0]))} ↔ ${esc(nameOf(p[1]))}`)).join("");
}

function renderAgents() {
  $("#agents").innerHTML = S.state.agents.map((a) => {
    const p = a.presence || {}; const m = a.model || {};
    const state = { running: `working${p.detail ? " — for " + p.detail : ""} since ${hhmm(p.since)}`,
                    failing: `last turn failed: ${p.detail || ""}`, idle: `idle${p.since ? ", last turn " + hhmm(p.since) : ""}`,
                    offline: "offline (no supervisor)" }[p.state] || "";
    const over = (m.source || "").startsWith("override");
    const bad = m.available === false;
    const fallsBack = over && m.roster_available === false;
    const tip = bad ? `${m.model} is not offered by this team's runner: every turn will fail. Click to choose another.`
      : fallsBack ? `${m.source}. When it expires, ${a.name} goes back to the roster's ${m.roster_model}, which this runner does not offer.`
      : (m.source || "");
    return `<li data-agent="${esc(a.name)}"><span class="dot ${esc(p.state || "offline")}"></span><span class="name" title="${esc(a.name)}">${esc(nameOf(a.name))}${a.alias ? ` <span class="alias-of">${esc(a.name)}</span>` : ""}</span>
      <button class="model ${over ? "override" : ""} ${bad ? "unavailable" : ""}" data-agent="${esc(a.name)}" title="${esc(tip)}">${bad || fallsBack ? "⚠ " : ""}${esc(m.model || "default")}${m.effort ? "·" + esc(m.effort) : ""}</button>
      <span class="state" title="${esc(state)}">${esc(state)}</span></li>`;
  }).join("");
}

function renderTasks() {
  const done = $("#show-done").checked;
  const groups = {};
  for (const t of S.state.tasks || []) {
    const finished = ["done", "cancelled", "abandoned"].includes(t.status);
    if (finished && !done) continue;
    (groups[t.status || "open"] ||= []).push(t);
  }
  const order = ["running", "claimed", "blocked", "review", "queued", "icebox", "done", "failed", "cancelled"];
  const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  $("#tasks").innerHTML = keys.length ? keys.map((k) => `<div class="task-group">${esc(k)} · ${groups[k].length}</div>` +
    groups[k].map((t) => `<div class="task"><div class="t"><a href="${boardURL(t.id)}" target="agy-board" title="Open on the board">${esc(t.title)}</a></div><div class="meta">
      <span>${esc(t.owner ? nameOf(t.owner) : "unclaimed")}</span><span class="tag">${esc(t.project || "")}</span>
      ${t.channel ? `<span class="chan" data-view='${esc(JSON.stringify({ type: "channel", id: t.channel }))}'>#${esc(t.channel)}</span>` : ""}
      ${t.requires_review ? `<span class="tag ${t.reviewed ? "ok" : "rev"}">${t.reviewed ? "reviewed" : "needs review"}</span>` : ""}
      ${t.check_after ? `<span class="tag" title="reminder">⏰ ${esc(String(t.check_after).slice(5, 16))}</span>` : ""}
      ${t.until ? `<span class="tag">waiting on condition</span>` : ""}</div></div>`).join("")).join("")
    : `<div class="task-group">no tasks</div>`;
}

async function openView(v) {
  S.view = v; save(`agychat.view.${S.team}`, v);
  const st = S.state;
  const c = v.type === "channel" ? (st.channels || {})[v.id] || {} : {};
  delete S.atMe[viewKey(v)];
  const banner = $("#view-banner");
  banner.classList.toggle("hidden", !c.archived);
  if (c.archived) banner.innerHTML = c.deleted
    ? `Deleted ${esc(c.deleted)}. Its history is hidden here and kept in the team's record. <button class="btn small" data-chan-act="restore">Restore</button>`
    : `Archived ${esc(c.archived)}: read-only, and out of every agent's channel list. <button class="btn small" data-chan-act="restore">Restore</button>`;
  if (v.type === "channel") {
    $("#view-title").textContent = `# ${v.id}`;
    $("#view-sub").textContent = `${(c.members || []).map(nameOf).join(", ") || "no agents"}${c.topic ? " — " + c.topic : ""}`;
    $("#input").placeholder = `Message #${v.id} — only @mentions wake agents (@name, @here, @all)`;
    $("#edit-members").classList.remove("hidden");
    $("#new-task").classList.toggle("hidden", !!c.archived);
  } else {
    const other = v.pair.find((p) => p !== "user") || v.pair[0];
    const mine = v.pair.includes("user") && other !== "supervisor";
    $("#view-title").textContent = mine ? nameOf(other) : v.pair.map(nameOf).join(" ↔ ");
    $("#view-sub").textContent = mine ? "direct messages — every message wakes them" :
      other === "supervisor" ? "notices from the supervisor" : "agent-to-agent conversation (read-only)";
    $("#input").placeholder = mine ? `Message ${nameOf(other)}` : "Read-only";
    $("#edit-members").classList.add("hidden");
    $("#new-task").classList.add("hidden");
  }
  renderViewTasks();
  $("#composer").classList.toggle("hidden", !!c.archived ||
    (v.type === "dm" && (!v.pair.includes("user") || v.pair.includes("supervisor"))));
  const params = v.type === "channel" ? { channel: v.id } : { dm: v.pair.join(",") };
  const res = await api(`/api/messages?${q(params)}`);
  S.messages = res.messages; S.replyCounts = res.reply_counts || S.replyCounts;
  markSeen(); renderMessages(); renderSidebar();
}

// The tasks this channel is about: the ones that name it.
function renderViewTasks() {
  const box = $("#view-tasks"); const v = S.view;
  const mine = v && v.type === "channel" ? (S.state.tasks || []).filter((t) => t.channel === v.id) : [];
  const open = mine.filter((t) => !TERMINAL.has(t.status));
  box.classList.toggle("hidden", !mine.length);
  box.innerHTML = open.map((t) => `<a class="task-chip" href="${boardURL(t.id)}" target="agy-board" title="${esc(t.status)} · ${esc(t.owner ? nameOf(t.owner) : "unclaimed")}">
      <span class="st ${esc(t.status)}"></span>${esc(t.title)}</a>`).join("")
    + (mine.length > open.length ? `<a class="task-chip" href="${boardURL()}" target="agy-board">${mine.length - open.length} closed</a>` : "");
}

function markSeen() {
  const last = S.messages[S.messages.length - 1];
  const k = viewKey(S.view);
  if (last) { S.seen[`${S.team}|${k}`] = last.ts; S.latest[k] = S.latest[k] > last.ts ? S.latest[k] : last.ts; save("agychat.seen", S.seen); }
}

function renderMessages() {
  const box = $("#messages");
  const showQuiet = $("#show-quiet").checked;
  const roots = S.messages.filter((m) => !m.thread || !S.messages.some((r) => r.id === m.thread));
  if (!roots.length) { box.innerHTML = `<div class="empty">Nothing here yet.</div>`; return; }
  const html = []; let hidden = 0;
  const flush = () => { if (hidden) { html.push(`<div class="collapsed-quiet" data-unhide="1">${hidden} quiet update${hidden > 1 ? "s" : ""} (ack, fyi, status) hidden</div>`); hidden = 0; } };
  for (const m of roots) {
    if (!showQuiet && QUIET.has(m.kind)) { hidden++; continue; }
    flush(); html.push(msgHTML(m, { showTo: S.view.type === "dm" && !S.view.pair.includes("user") }));
  }
  flush();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = html.join("");
  if (atBottom || !renderMessages.done) box.scrollTop = box.scrollHeight;
  renderMessages.done = true;
}

// --- drawer -----------------------------------------------------------------------

function openDrawer(tab) {
  $("#drawer").classList.remove("hidden"); $("#drawer-split").classList.remove("hidden");
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const t of ["thread", "artifact", "activity"]) $(`#drawer-${t}`).classList.toggle("hidden", tab !== t);
}

async function openThread(id) {
  S.thread = id;
  const { messages } = await api(`/api/messages?${q({ thread: id })}`);
  const root = messages.find((m) => m.id === id) || messages[0];
  const where = root?.channel ? { channel: root.channel } : { to: (root?.from === "user" ? root?.to : root?.from) };
  const canReply = root && (root.channel || root.from === "user" || root.to === "user");
  $("#drawer-thread").innerHTML = messages.map((m) => msgHTML(m, { inThread: true })).join("") +
    (canReply ? `<form class="thread-compose" data-where='${esc(JSON.stringify(where))}'><textarea rows="2" placeholder="Reply in thread"></textarea>
      <div class="composer-row"><span class="hint">${root.channel ? "mention to wake" : "wakes " + esc(where.to)}</span><button class="btn small">Reply</button></div></form>` : "");
  openDrawer("thread");
}

async function openArtifact(path) {
  openDrawer("artifact");
  const box = $("#drawer-artifact");
  box.innerHTML = `<div class="artifact-head">${esc(path)}</div><div class="empty">loading…</div>`;
  try {
    const a = await api(`/api/artifact?${q({ path })}`);
    if (a.error) throw new Error(a.error);
    let body;
    if (a.kind === "dir") body = `<ul class="dir-list">${a.entries.map((e) => `<li data-path="${esc(e.path)}">${esc(e.name)}</li>`).join("")}</ul>`;
    else if (a.kind === "binary") body = `<div class="empty">binary file, ${a.size} bytes</div>`;
    else if (a.kind === "markdown") body = `<div class="artifact-md body">${markdown(a.content)}</div>`;
    else if (a.kind === "diff") body = `<div class="artifact">${esc(a.content).split("\n").map((l) =>
      `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${l}</span>`).join("\n")}</div>`;
    else body = `<div class="artifact">${esc(a.content)}</div>`;
    box.innerHTML = `<div class="artifact-head">${esc(a.path)}${a.truncated ? " (truncated)" : ""}</div>${body}`;
  } catch (e) {
    box.innerHTML = `<div class="artifact-head">${esc(path)}</div><div class="empty">${esc(e.message)}</div>`;
  }
}

async function openActivity(agent) {
  openDrawer("activity");
  const box = $("#drawer-activity");
  const { events } = await api(`/api/activity?${q({ agent })}`);
  const rows = events.slice().reverse().map((e) => {
    const when = `<span class="when">${esc((e.ts || "").slice(5, 16))}</span>`;
    if (e.event === "tool_call") {
      const args = e.args ? esc(JSON.stringify(e.args)).slice(0, 400) : "";
      return `<details class="act"><summary>${when} <code>${esc(e.tool || "tool")}</code>${e.error ? ' <span class="badge blocker">error</span>' : ""}</summary><pre>${args}${e.result ? "\n→ " + esc(String(e.result)).slice(0, 600) : ""}</pre></details>`;
    }
    if (e.event === "turn") return `<div class="act">${when} <strong>turn</strong> ${e.duration_s ? Math.round(e.duration_s) + "s" : ""} · ${(e.input_tokens || 0).toLocaleString()} in · ${esc(e.model || "")}</div>`;
    if (e.event === "failure") return `<div class="act">${when} <span class="badge blocker">failed</span> ${esc((e.error || "").slice(0, 300))}</div>`;
    return `<div class="act">${when} ${esc(e.event)}</div>`;
  }).join("");
  box.innerHTML = `<div class="artifact-head">${esc(nameOf(agent))} — recent turns, tool calls and failures (newest first)</div>${rows || '<div class="empty">no recorded activity</div>'}`;
}

// --- posting ------------------------------------------------------------------------

async function send(content, where, thread) {
  const kind = thread ? "work" : $("#kind").value;
  const r = await api("/api/post", { ...where, content, thread, kind });
  const idle = S.state && !S.state.supervisor ? " — but no supervisor is running, so nothing wakes until you Start team" : "";
  if (r.woke) toast((r.woke.length ? `woke ${r.woke.join(", ")}` : "posted — nobody mentioned, so nobody was woken") + (r.woke.length ? idle : ""));
  else toast("sent" + idle);
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim(); if (!text) return;
  const v = S.view;
  const where = v.type === "channel" ? { channel: v.id } : { to: v.pair.find((p) => p !== "user") };
  try { await send(text, where); $("#input").value = ""; $("#kind").value = "work"; } catch (err) { toast(err.message, true); }
});
$("#input").addEventListener("keydown", (e) => {
  if (!$("#mention-box").classList.contains("hidden") && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return mentionKey(e);
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#input").addEventListener("input", mentionSuggest);

// @mention autocomplete
function mentionSuggest() {
  const ta = $("#input"); const before = ta.value.slice(0, ta.selectionStart);
  const m = before.match(/(?:^|\s)@([\w-]*)$/); const box = $("#mention-box");
  if (!m) return box.classList.add("hidden");
  // "@Ada" offers at-Ada: a name matches on its start or on any part after a
  // team prefix, ignoring case, as agy-team resolves it.
  // An agent is offered by its alias (inserted as @alias) and found by
  // either; a name also matches past a team prefix.
  const q = m[1].toLowerCase();
  const parts = (n) => n.toLowerCase().split(/(?=[-_.])/).map((_, i, ps) => ps.slice(i).join("").replace(/^[-_.]/, ""));
  const opts = [...S.state.agents.map((a) => ({ handle: a.alias || a.name, hint: a.alias ? a.name : "", keys: [...parts(a.name), ...(a.alias ? [a.alias.toLowerCase()] : [])] })),
                { handle: "here", hint: "everyone in this channel", keys: ["here"] },
                { handle: "all", hint: "the whole team", keys: ["all"] }]
    .filter((o) => o.keys.some((k) => k.startsWith(q)));
  if (!opts.length) return box.classList.add("hidden");
  box.innerHTML = opts.map((o, i) => `<div class="item ${i ? "" : "sel"}" data-name="${esc(o.handle)}">@${esc(o.handle)}
    <span class="k">${esc(o.hint)}</span></div>`).join("");
  box.classList.remove("hidden");
}
function mentionPick(name) {
  const ta = $("#input"); const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos).replace(/@([\w-]*)$/, `@${name} `);
  ta.value = before + ta.value.slice(pos); ta.selectionStart = ta.selectionEnd = before.length;
  $("#mention-box").classList.add("hidden"); ta.focus();
}
function mentionKey(e) {
  const items = [...document.querySelectorAll("#mention-box .item")]; let i = items.findIndex((x) => x.classList.contains("sel"));
  if (e.key === "Escape") { $("#mention-box").classList.add("hidden"); return e.preventDefault(); }
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return mentionPick(items[i].dataset.name); }
  e.preventDefault(); items[i]?.classList.remove("sel");
  i = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[i].classList.add("sel");
}
$("#mention-box").addEventListener("mousedown", (e) => { const it = e.target.closest(".item"); if (it) { e.preventDefault(); mentionPick(it.dataset.name); } });

// --- live -----------------------------------------------------------------------------

function listen() {
  if (S.events) S.events.close();
  S.events = new EventSource(`/api/events?${q({})}`);
  let refetch = null;
  const later = () => { clearTimeout(refetch); refetch = setTimeout(() => refreshState().catch(() => {}), 400); };
  S.events.onmessage = (ev) => {
    const { stream, item } = JSON.parse(ev.data);
    if (stream === "bus") {
      if (item.thread) S.replyCounts[item.thread] = (S.replyCounts[item.thread] || 0) + 1;
      const k = item.from === "supervisor" ? `d:supervisor,user` : keyOf(item);
      if (k && !(item.from === "supervisor" && item.to !== "user")) S.latest[k] = item.ts;
      if (k && mentionsMe(item) && !(S.view && k === viewKey(S.view))) S.atMe[k] = true;
      if (S.view && k === viewKey(S.view)) { S.messages.push(item); markSeen(); renderMessages(); }
      if (S.thread && (item.thread === S.thread || item.id === S.thread)) openThread(S.thread);
      renderSidebar();
      if (item.from !== "user" && item.from !== "supervisor" && (item.to === "user" || mentionsMe(item))) document.title = `• agy-chat`;
    } else later();
  };
  S.events.onerror = () => { setTimeout(() => { if (S.events.readyState === 2) listen(); }, 3000); };
}
window.addEventListener("focus", () => { document.title = "agy-chat"; });

// --- clicks ---------------------------------------------------------------------------

document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav) return openView(JSON.parse(nav.dataset.view));
  const th = e.target.closest("[data-thread]");
  if (th) return openThread(th.dataset.thread);
  const mk = e.target.closest("[data-mktask]");
  if (mk) return taskModal({ fromMessage: S.messages.find((m) => m.id === mk.dataset.mktask) });
  const ca = e.target.closest("[data-chan-act]");
  if (ca) return channelAction(ca.dataset.chanAct, S.view.id);
  const f = e.target.closest("[data-path]");
  if (f) return openArtifact(f.dataset.path);
  if (e.target.closest("[data-unhide]")) { $("#show-quiet").checked = true; return renderMessages(); }
  const model = e.target.closest(".model[data-agent]");
  if (model) return modelModal(model.dataset.agent);
  const ag = e.target.closest("#agents li[data-agent]");
  if (ag) return openActivity(ag.dataset.agent);
  const tab = e.target.closest(".tab");
  if (tab) return openDrawer(tab.dataset.tab);
});
document.addEventListener("submit", async (e) => {
  const form = e.target.closest(".thread-compose"); if (!form) return;
  e.preventDefault(); const ta = form.querySelector("textarea"); const text = ta.value.trim(); if (!text) return;
  try { await send(text, JSON.parse(form.dataset.where), S.thread); ta.value = ""; } catch (err) { toast(err.message, true); }
});
$("#drawer-close").onclick = () => { $("#drawer").classList.add("hidden"); $("#drawer-split").classList.add("hidden"); S.thread = null; };
$("#team").onchange = (e) => { S.team = e.target.value; openTeam(); };
$("#show-quiet").onchange = renderMessages;
$("#show-done").onchange = renderTasks;
$("#archived-toggle").onclick = () => { save("agychat.showArchived", !load("agychat.showArchived", false)); renderSidebar(); };
$("#sup-start").onclick = async () => { try { const r = await api("/api/supervisor", { action: "start" }); toast(r.started ? `supervisor started (pid ${r.pid})` : r.reason); setTimeout(refreshState, 1500); } catch (e) { toast(e.message, true); } };
$("#sup-restart").onclick = async () => {
  const b = S.state.supervisor || {};
  if (!b.restartable) { toast("This supervisor predates graceful restart: Stop and Start it once, or use Admin → Update.", true); return; }
  if (!confirm(`Restart ${S.team}'s supervisor on the installed code? No new turns start; ${(b.inflight || []).length ? (b.inflight.join(", ") + " finish first") : "nothing is running"}. Mail keeps queuing.`)) return;
  try { await api("/api/supervisor", { action: "restart" }); toast("restart requested"); setTimeout(refreshState, 1000); } catch (e) { toast(e.message, true); }
};
$("#sup-stop").onclick = async () => { if (!confirm("Stop the team? Turns in flight are cancelled; their mail stays queued and is delivered again on Start. To keep them, use Restart.")) return; try { await api("/api/supervisor", { action: "stop" }); toast("stopping"); setTimeout(refreshState, 1500); } catch (e) { toast(e.message, true); } };

// --- modals ---------------------------------------------------------------------------

function modal(html, onSubmit, extraActions = "") {
  $("#modal-card").innerHTML = `<form>${html}<div class="modal-actions"><span class="left-actions">${extraActions}</span><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn">Save</button></div></form>`;
  $("#modal").classList.remove("hidden");
  const form = $("#modal-card form");
  form.querySelector("[data-cancel]").onclick = () => $("#modal").classList.add("hidden");
  form.onsubmit = async (e) => { e.preventDefault(); try { await onSubmit(new FormData(form), form); $("#modal").classList.add("hidden"); } catch (err) { toast(err.message, true); } };
  wireChecks(form);
  form.querySelector("input,select")?.focus();
}
const agentChecks = (checked = [], everyone = false) => `
  <label class="everyone"><input type="checkbox" name="everyone" ${everyone ? "checked" : ""}> Every agent, including ones added later</label>
  <div class="checks-wrap ${everyone ? "hidden" : ""}"><div class="checks-tools"><button type="button" class="link" data-all>all</button> · <button type="button" class="link" data-none>none</button></div>
  <div class="checks">${S.state.agents.map((a) =>
  `<label title="${esc(a.name)}"><input type="checkbox" name="m" value="${esc(a.name)}" ${everyone || checked.includes(a.name) ? "checked" : ""}> ${esc(nameOf(a.name))}</label>`).join("")}</div></div>`;
// The "every agent" switch and the all/none shortcuts in a members picker.
function wireChecks(form) {
  const all = form.querySelector("[name=everyone]"); const wrap = form.querySelector(".checks-wrap");
  if (!all) return;
  all.onchange = () => wrap.classList.toggle("hidden", all.checked);
  form.querySelector("[data-all]").onclick = () => form.querySelectorAll("[name=m]").forEach((c) => (c.checked = true));
  form.querySelector("[data-none]").onclick = () => form.querySelectorAll("[name=m]").forEach((c) => (c.checked = false));
}

$("#new-channel").onclick = () => modal(`<h3>New channel</h3><label>Name</label><input type="text" name="name" placeholder="billing" required>
  <label>Topic</label><input type="text" name="topic" placeholder="optional"><label>Agents in it</label>${agentChecks([], true)}`,
  async (fd) => { await api("/api/channel", { action: "create", name: fd.get("name"), topic: fd.get("topic"),
                                              everyone: !!fd.get("everyone"), members: fd.getAll("m") });
    await refreshState(); openView({ type: "channel", id: String(fd.get("name")).toLowerCase() }); });

$("#edit-members").onclick = () => {
  const name = S.view.id; const c = S.state.channels[name] || {}; const before = c.members || [];
  const acts = c.archived
    ? `<button type="button" class="btn ghost" data-chan-act="restore">Restore</button>`
    : `<button type="button" class="btn ghost" data-chan-act="archive">Archive</button>
       <button type="button" class="btn danger" data-chan-act="delete">Delete…</button>`;
  modal(`<h3>#${esc(name)}</h3><label>Topic</label><input type="text" name="topic" value="${esc(c.topic || "")}">
    <label>Agents in it</label>${agentChecks(before, !!c.everyone)}
    <div class="hint" style="margin-top:10px">Archive: read-only, out of every agent's list, reversible.
    Delete: archive and hide its history here; the messages stay in the team's record, and Restore brings it back.</div>`,
    async (fd) => {
      const after = fd.getAll("m");
      if (fd.get("topic") !== (c.topic || "")) await api("/api/channel", { action: "topic", name, topic: fd.get("topic") });
      if (fd.get("everyone")) { if (!c.everyone) await api("/api/channel", { action: "members", name, everyone: true }); }
      else await api("/api/channel", { action: "members", name, everyone: false,
                                       add: after.filter((x) => !before.includes(x)), remove: before.filter((x) => !after.includes(x)) });
      await refreshState(); openView(S.view);
    }, acts);
};

async function channelAction(act, name) {
  if (act === "delete" && !confirm(`Delete #${name}? It is archived and its history hidden here; the messages stay in the team's record, and Restore brings it all back.`)) return;
  try {
    await api("/api/channel", { action: act, name });
    $("#modal").classList.add("hidden");
    toast({ archive: `#${name} archived`, delete: `#${name} deleted`, restore: `#${name} restored` }[act]);
    await refreshState(); openView({ type: "channel", id: name });
  } catch (err) { toast(err.message, true); }
}

// A task, from the channel header (linked to it) or from a message.
function taskModal({ fromMessage } = {}) {
  const v = S.view; const m = fromMessage;
  const channel = m?.channel || (v.type === "channel" ? v.id : "");
  const projects = [...new Set((S.state.tasks || []).map((t) => t.project).filter(Boolean))];
  const open = Object.entries(S.state.channels || {}).filter(([, c]) => !c.archived).map(([n]) => n).sort();
  const title = m ? (m.content || "").split("\n")[0].slice(0, 120) : "";
  const note = m ? `From ${sender(m)}${m.channel ? " in #" + m.channel : ""} at ${m.ts}${m.id ? " (message " + m.id + ")" : ""}:\n${m.content}` : "";
  modal(`<h3>New task</h3><label>Title</label><input type="text" name="title" value="${esc(title)}" required>
    <label>Project</label><input type="text" name="project" list="projects" value="${esc(channel || projects[0] || "")}" required>
    <datalist id="projects">${projects.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    <label>Owner</label><select name="owner"><option value="">nobody yet</option>${S.state.agents.map((a) => `<option value="${esc(a.name)}">${esc(nameOf(a.name))}</option>`).join("")}</select>
    <label>Channel</label><select name="channel"><option value="">none</option>${open.map((n) => `<option ${n === channel ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
    <label>Column</label><select name="status"><option value="queued">To do</option><option value="icebox">Icebox</option></select>
    <label>Note</label><textarea name="note" rows="4" style="width:100%">${esc(note)}</textarea>
    <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="rr"> requires an approved review to close</label>`,
    async (fd) => {
      const t = await api("/api/task", { action: "create", title: fd.get("title"), project: fd.get("project"),
        owner: fd.get("owner") || null, channel: fd.get("channel") || null, status: fd.get("status"),
        note: fd.get("note"), requires_review: !!fd.get("rr") });
      toast(`created ${t.id}` + (t.owner && t.status !== "icebox" ? `; ${nameOf(t.owner)} was told` : ""));
      refreshState();
    });
}
$("#new-task").onclick = () => taskModal();

async function modelModal(agent) {
  const a = S.state.agents.find((x) => x.name === agent); const m = a.model || {};
  let offered = null, runnerLabel = "";
  try { const r = await api(`/api/models?${q({})}`); offered = r.models; runnerLabel = r.runner || ""; } catch {}
  const over = (m.source || "").startsWith("override");
  const current = over ? m.model : "";
  const picker = offered
    ? `<select name="model"><option value="">the roster's choice${m.roster_model ? ` (${esc(m.roster_model)}${m.roster_available === false ? " — NOT offered, turns would fail" : ""})` : " (runner default)"}</option>
        ${offered.map((o) => `<option value="${esc(o.id)}" ${o.id === current ? "selected" : ""}>${esc(o.label)} — ${esc(o.id)}</option>`).join("")}</select>
       <div class="hint">${offered.length} models offered by the ${esc(runnerLabel)} runner</div>`
    : `<input type="text" name="model" value="${esc(current)}" placeholder="model id">
       <div class="hint">This runner cannot list its models; type the id it expects.</div>`;
  modal(`<h3>${esc(agent)}'s model</h3>
    <div class="hint">now: ${esc(m.model || "runner default")} — ${esc(m.source || "")}${m.available === false ? " — <b>not offered by this runner</b>" : ""}</div>
    <label>Model</label>${picker}
    <label>Until</label><select name="until"><option value="">until I change it</option><option>4h</option><option>1d</option><option selected>3d</option><option>7d</option></select>
    <div class="hint" style="margin-top:8px">Applied at ${esc(agent)}'s next idle moment: it distills, then starts a fresh conversation on the new model.
    When an override expires the agent goes back to the roster's model${m.available === false && !over ? "" : ""}.</div>`,
    async (fd) => { const r = await api("/api/model", { agent, model: fd.get("model") || null, until: fd.get("until") || null });
      toast(r.model ? `${agent} → ${r.model}` : `${agent} back to the roster's model`); refreshState(); });
}

// --- search -----------------------------------------------------------------------------

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer); const v = e.target.value.trim(); const box = $("#search-results");
  if (!v) return box.classList.add("hidden");
  searchTimer = setTimeout(async () => {
    const { hits } = await api(`/api/search?${q({ q: v })}`);
    box.innerHTML = hits.length ? hits.map((h, i) => {
      if (h.type === "message") { const m = h.item;
        const view = m.channel ? { type: "channel", id: m.channel } : { type: "dm", pair: [m.from, m.to].sort() };
        return `<div class="item" data-hit='${esc(JSON.stringify({ view, id: m.id }))}'><span class="k">${m.channel ? "#" + esc(m.channel) : esc(m.from) + " → " + esc(m.to)}</span>${esc((m.content || "").slice(0, 160))}</div>`; }
      if (h.type === "task") return `<div class="item"><span class="k">task · ${esc(h.item.status)}</span>${esc(h.item.title)} — ${esc(h.item.owner || "")}</div>`;
      return `<div class="item"><span class="k">norm</span>${esc(h.item.text)}</div>`;
    }).join("") : `<div class="item">no matches</div>`;
    box.classList.remove("hidden");
  }, 180);
});
$("#search-results").addEventListener("click", async (e) => {
  const it = e.target.closest("[data-hit]"); if (!it) return;
  const { view, id } = JSON.parse(it.dataset.hit); $("#search-results").classList.add("hidden");
  await openView(view);
  const el = document.querySelector(`.msg[data-id="${CSS.escape(id || "")}"]`);
  if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); } else if (id) openThread(id);
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search").focus(); }
  if (e.key === "Escape") $("#search-results").classList.add("hidden");
});

// --- resizable panes ----------------------------------------------------------------

const LAYOUT = load("agychat.layout", {});
function applyLayout() {
  $(".left").style.width = LAYOUT.left ? LAYOUT.left + "px" : "";
  $("#drawer").style.width = LAYOUT.drawer ? LAYOUT.drawer + "px" : "";
  $(".left .discourse").style.flex = LAYOUT.ops ? `0 0 ${LAYOUT.ops}%` : "";
  $(".left .ops").style.flex = LAYOUT.ops ? "1 1 0" : "";
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
document.addEventListener("mousedown", (e) => {
  const sp = e.target.closest(".splitter"); if (!sp) return;
  e.preventDefault();
  const which = sp.dataset.split; const left = $(".left").getBoundingClientRect();
  sp.classList.add("active"); document.body.classList.add("dragging", which === "ops" ? "row" : "col");
  const move = (ev) => {
    if (which === "left") LAYOUT.left = clamp(ev.clientX - left.left, 180, Math.min(640, innerWidth - 420));
    if (which === "drawer") LAYOUT.drawer = clamp(innerWidth - ev.clientX, 300, Math.min(1000, innerWidth - 480));
    if (which === "ops") LAYOUT.ops = clamp((ev.clientY - left.top) / left.height * 100, 12, 88);
    applyLayout();
  };
  const up = () => { sp.classList.remove("active"); document.body.classList.remove("dragging", "row", "col");
    removeEventListener("mousemove", move); removeEventListener("mouseup", up); save("agychat.layout", LAYOUT); };
  addEventListener("mousemove", move); addEventListener("mouseup", up);
});
document.addEventListener("dblclick", (e) => {
  const sp = e.target.closest(".splitter"); if (!sp) return;
  delete LAYOUT[sp.dataset.split]; save("agychat.layout", LAYOUT); applyLayout();
});
applyLayout();

loadTeams().catch((e) => toast(e.message, true));

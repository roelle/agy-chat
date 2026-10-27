/* agy-chat's board: the team's tasks as a Kanban, cross-linked with chat.
   No framework, no build: state in one object, DOM by hand, like app.js. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// Columns, left to right. A card shows in the column holding its status; a
// card dropped on a column takes the column's status ("drop").
const COLS = [
  { key: "icebox", title: "Icebox", statuses: ["icebox"], drop: "icebox" },
  { key: "todo", title: "To do", statuses: ["queued"], drop: "queued" },
  { key: "doing", title: "In progress", statuses: ["claimed", "running"], drop: "running" },
  { key: "blocked", title: "Blocked", statuses: ["blocked"], drop: "blocked" },
  { key: "review", title: "Review", statuses: ["review"], drop: "review" },
  { key: "done", title: "Done", statuses: ["done"], drop: "done" },
  { key: "closed", title: "Failed / cancelled", statuses: ["failed", "cancelled"], drop: "cancelled", optional: true },
];
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const STATUSES = ["icebox", "queued", "claimed", "running", "blocked", "review", "done", "failed", "cancelled"];

const S = { teams: [], team: null, state: null, tasks: [], selected: null, events: null, drag: null };

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

function nameOf(n) {
  if (!n) return "unassigned";
  if (n === "user") return S.state?.operator?.name || "you";
  return (S.state?.agents || []).find((a) => a.name === n)?.alias || n;
}
const chatURL = (hash) => `/?team=${encodeURIComponent(S.team)}${hash ? "#" + hash : ""}`;
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    (d.getHours() || d.getMinutes() ? " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
}

// --- loading --------------------------------------------------------------------

async function loadTeams() {
  const { teams } = await api("/api/teams");
  S.teams = teams;
  $("#team").innerHTML = teams.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  const asked = new URLSearchParams(location.search).get("team");
  const want = asked || load("agychat.team", null);
  S.team = teams.some((t) => t.name === want) ? want : teams[0]?.name;
  if (!S.team) { $("#board").innerHTML = `<div class="empty">No teams found.</div>`; return; }
  $("#team").value = S.team;
  await openTeam();
}

async function openTeam() {
  save("agychat.team", S.team);
  history.replaceState(null, "", `/board?team=${encodeURIComponent(S.team)}${location.hash}`);
  renderNav("board", S.team, () => { render(); if (S.selected) openDetail(S.selected); });
  await refresh();
  const prefs = load(`agyboard.prefs.${S.team}`, {});
  $("#lanes").value = prefs.lanes || ""; $("#show-closed").checked = !!prefs.closed;
  render();
  const id = new URLSearchParams(location.hash.slice(1)).get("task");
  if (id) openDetail(id);
  listen();
}

async function refresh() {
  const [st, tk] = await Promise.all([api(`/api/state?${q({})}`), api(`/api/tasks?${q({})}`)]);
  S.state = st; S.tasks = tk.tasks;
  fillFilters();
}

function fillFilters() {
  const keep = (sel, opts, all) => { const v = sel.value;
    sel.innerHTML = `<option value="">${all}</option>` + opts.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join("");
    sel.value = opts.some(([x]) => x === v) ? v : ""; };
  const owners = [...new Set(S.tasks.map((t) => t.owner || ""))].sort().map((o) => [o || "-", nameOf(o)]);
  keep($("#owner"), owners, "every owner");
  keep($("#project"), [...new Set(S.tasks.map((t) => t.project))].filter(Boolean).sort().map((p) => [p, p]), "every project");
}

// --- the board ----------------------------------------------------------------

function visible() {
  const f = $("#filter").value.trim().toLowerCase(), owner = $("#owner").value, project = $("#project").value;
  return S.tasks.filter((t) =>
    (!owner || (t.owner || "-") === owner) && (!project || t.project === project) &&
    (!f || [t.title, t.id, t.project, t.owner, nameOf(t.owner), t.note, t.channel].some((x) => (x || "").toLowerCase().includes(f))));
}
const order = (a, b) => ((a.rank ?? Infinity) - (b.rank ?? Infinity)) || (b.updated_at || "").localeCompare(a.updated_at || "");
const cols = () => COLS.filter((c) => !c.optional || $("#show-closed").checked);

function render() {
  const lanesBy = $("#lanes").value;
  const rows = visible();
  const lanes = lanesBy ? [...new Set(rows.map((t) => t[lanesBy] || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b)) : [null];
  const board = $("#board");
  board.classList.toggle("no-lanes", !lanesBy);
  board.innerHTML = lanes.map((lane) => {
    const mine = lane === null ? rows : rows.filter((t) => (t[lanesBy] || "") === lane);
    const head = lane === null ? "" : `<div class="lane-head">${esc(lanesBy === "owner" ? nameOf(lane) : lane || "no project")}<span class="n">${mine.length}</span></div>`;
    return `<section class="lane" data-lane="${esc(lane ?? "")}">${head}<div class="cols">${cols().map((c) => {
      const cards = mine.filter((t) => c.statuses.includes(t.status)).sort(order);
      return `<div class="col" data-col="${c.key}" data-lane="${esc(lane ?? "")}">
        <div class="col-head"><span>${esc(c.title)}</span><span class="n">${cards.length}</span></div>
        ${cards.map(cardHTML).join("") || `<div class="empty-col">—</div>`}</div>`;
    }).join("")}</div></section>`;
  }).join("") || `<div class="empty">No tasks yet. + Task makes one; agents make them with create_task.</div>`;
}

function cardHTML(t) {
  const now = new Date().toISOString();
  const over = t.deadline && t.deadline < now && !TERMINAL.has(t.status);
  return `<div class="card ${S.selected === t.id ? "selected" : ""}" data-id="${esc(t.id)}">
    <div class="ct">${esc(t.title)}</div>
    <div class="cm"><span class="who">${esc(nameOf(t.owner))}</span>
      ${$("#lanes").value !== "project" ? `<span class="tag">${esc(t.project || "")}</span>` : ""}
      ${t.channel ? `<a class="chan" href="${chatURL("channel=" + encodeURIComponent(t.channel))}" title="Open the channel">#${esc(t.channel)}</a>` : ""}
      ${t.deadline ? `<span class="due ${over ? "over" : ""}" title="deadline ${esc(t.deadline)}">due ${esc(fmtDate(t.deadline))}</span>` : ""}
      ${t.check_after && !TERMINAL.has(t.status) ? `<span title="reminder ${esc(t.check_after)}">⏰</span>` : ""}
      ${t.requires_review ? `<span class="tag ${t.reviewed ? "ok" : "rev"}">${t.reviewed ? "reviewed" : "needs review"}</span>` : ""}
      ${t.status === "claimed" ? `<span title="claimed, not yet reported running">claimed</span>` : ""}
      ${t.usage && t.usage.tokens ? `<span class="tokens" title="tokens spent on it (an estimate)">${tokens(t.usage.tokens)}</span>` : ""}
    </div></div>`;
}

// --- dragging: a column is a status, a lane an owner or project, a position a rank ------
//
// Pointer events rather than HTML5 drag and drop, which touch screens do not
// have. A press that moves less than a few pixels is a click.

document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".card"); if (!card || e.button !== 0 || e.target.closest("a")) return;
  S.press = { id: card.dataset.id, card, x: e.clientX, y: e.clientY, ghost: null };
});
document.addEventListener("pointermove", (e) => {
  const p = S.press; if (!p) return;
  if (!p.ghost) {
    if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 6) return;
    const r = p.card.getBoundingClientRect();
    p.ghost = p.card.cloneNode(true); p.ghost.classList.add("ghost");
    Object.assign(p.ghost.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
    p.dx = e.clientX - r.left; p.dy = e.clientY - r.top;
    document.body.appendChild(p.ghost); p.card.classList.add("dragging"); S.drag = p.id;
    document.body.classList.add("dragging");
  }
  p.ghost.style.left = e.clientX - p.dx + "px"; p.ghost.style.top = e.clientY - p.dy + "px";
  const col = colAt(e.clientX, e.clientY);
  document.querySelectorAll(".col.over").forEach((x) => x !== col && x.classList.remove("over"));
  document.querySelectorAll(".drop-mark").forEach((x) => x.remove());
  p.col = col;
  if (!col) return;
  col.classList.add("over");
  const after = cardAfter(col, e.clientY);
  const mark = document.createElement("div"); mark.className = "drop-mark";
  after ? col.insertBefore(mark, after) : col.appendChild(mark);
});
document.addEventListener("pointerup", async (e) => {
  const p = S.press; S.press = null; if (!p) return;
  if (!p.ghost) return openDetail(p.id);               // a click
  const col = p.col; const before = col ? cardAfter(col, e.clientY)?.dataset.id || null : null;
  p.ghost.remove(); p.card.classList.remove("dragging"); document.body.classList.remove("dragging");
  document.querySelectorAll(".col.over").forEach((x) => x.classList.remove("over"));
  document.querySelectorAll(".drop-mark").forEach((x) => x.remove());
  S.drag = null;
  if (col) await dropCard(p.id, col.dataset.col, col.dataset.lane, before);
});
// The column under the pointer -- or, in the gap between lanes or below a
// short column, the one whose span holds it in the nearest row.
function colAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  const col = hit?.closest(".col"); if (col) return col;
  const row = hit?.closest(".cols") || [...document.querySelectorAll(".cols")].find((r) => {
    const b = r.getBoundingClientRect(); return y >= b.top && y <= b.bottom; });
  return row && [...row.children].find((c) => { const b = c.getBoundingClientRect(); return x >= b.left && x <= b.right; });
}
function cardAfter(col, y) {
  return [...col.querySelectorAll(".card:not(.dragging)")].find((c) => {
    const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
}

async function dropCard(id, colKey, lane, beforeId) {
  const t = S.tasks.find((x) => x.id === id); if (!t) return;
  const col = COLS.find((c) => c.key === colKey);
  const change = {};
  if (!col.statuses.includes(t.status)) change.status = col.drop;
  const lanesBy = $("#lanes").value;
  if (lanesBy && (t[lanesBy] || "") !== lane) {
    if (lanesBy === "project" && !lane) return toast("a task needs a project", true);
    change[lanesBy] = lane;
  }
  // Rank: between the neighbours it was dropped between. Cards nobody has
  // ordered yet sort after ordered ones; dropping among them orders the
  // ones above it first.
  const peers = S.tasks.filter((x) => x.id !== id && col.statuses.includes(x.status)
    && (!lanesBy || (x[lanesBy] || "") === (change[lanesBy] ?? lane))).sort(order);
  const at = beforeId ? peers.findIndex((x) => x.id === beforeId) : peers.length;
  const prev = peers[at - 1], next = peers[at];
  const writes = [];
  let rank;
  if (prev && prev.rank == null) {
    peers.slice(0, at).forEach((x, i) => writes.push({ id: x.id, rank: i + 1 }));
    rank = at + 1;
  } else if (prev && next && next.rank != null) rank = (prev.rank + next.rank) / 2;
  else if (prev) rank = prev.rank + 1;
  else if (next && next.rank != null) rank = next.rank - 1;
  else rank = 1;
  if (rank !== t.rank) change.rank = rank;
  if (!Object.keys(change).length && !writes.length) return;
  try {
    if (change.status === "done" && t.requires_review && !t.reviewed) {
      if (!confirm(`“${t.title}” requires an approved review and has none. Waive the review and close it? The waiver is recorded as yours.`)) return;
      await api("/api/task", { action: "waive", id, reason: "closed on the board without a review" });
    }
    for (const w of writes) await api("/api/task", { action: "update", ...w });
    await api("/api/task", { action: "update", id, ...change });
    const what = change.status ? `→ ${COLS.find((c) => c.statuses.includes(change.status))?.title || change.status}` : "";
    const who = change.owner !== undefined ? ` · now ${nameOf(change.owner)}` : "";
    if (what || who) toast(`${t.title} ${what}${who}` + (t.owner || change.owner ? " — the owner was told" : ""));
    await refresh(); render(); if (S.selected) openDetail(S.selected);
  } catch (err) { toast(err.message, true); await refresh(); render(); }
}

// --- one card, in full ----------------------------------------------------------

async function openDetail(id) {
  S.selected = id;
  history.replaceState(null, "", `#task=${encodeURIComponent(id)}`);
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
  document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.classList.add("selected");
  $("#detail").classList.remove("hidden"); $("#detail-split").classList.remove("hidden");
  let d;
  try { d = await api(`/api/task?${q({ id })}`); } catch (e) { $("#detail-body").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const t = d.task;
  const chans = Object.entries(S.state.channels || {}).filter(([n, c]) => !c.archived || n === t.channel).map(([n]) => n).sort();
  $("#detail-id").textContent = t.id;
  $("#detail-body").innerHTML = `<form class="detail-form" id="detail-form">
    <label>Title</label><input type="text" name="title" value="${esc(t.title)}">
    <div class="row"><div><label>Status</label><select name="status">${STATUSES.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div><label>Owner</label><select name="owner"><option value="">unassigned</option>${S.state.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === t.owner ? "selected" : ""}>${esc(nameOf(a.name))}</option>`).join("")}</select></div></div>
    <div class="row"><div><label>Project</label><input type="text" name="project" value="${esc(t.project)}"></div>
      <div><label>Channel</label><select name="channel"><option value="">none</option>${chans.map((n) => `<option ${n === t.channel ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div></div>
    <label>Deadline <span class="hint">(e.g. 3d, or 2026-11-01T17:00:00-07:00)</span></label><input type="text" name="deadline" value="${esc(t.deadline || "")}">
    <label>Note</label><textarea name="note" rows="5">${esc(t.note || "")}</textarea>
    <label>Links <span class="hint">(one per line: title | link — a web address, go link or path)</span></label>
    <div class="links">${(t.links || []).map(linkHTML).join("") || '<span class="hint">none</span>'}</div>
    <textarea name="links" rows="2" placeholder="PR | https://…&#10;Design | ~/docs/design.md">${esc((t.links || []).map((l) => l.title && l.title !== l.url ? `${l.title} | ${l.url}` : l.url).join("\n"))}</textarea>
    <div class="actions"><button class="btn">Save</button>
      ${t.channel ? `<a class="btn ghost" href="${chatURL("channel=" + encodeURIComponent(t.channel))}">Open #${esc(t.channel)}</a>` : ""}
      ${t.owner ? `<a class="btn ghost" href="${chatURL("dm=" + encodeURIComponent(t.owner))}">Message ${esc(nameOf(t.owner))}</a>` : ""}
      ${t.requires_review && !t.reviewed ? `<button type="button" class="btn ghost" id="waive">Waive review</button>` : ""}</div>
    ${usageHTML(t.usage)}
    <div class="hint" style="margin-top:6px">created by ${esc(nameOf(t.created_by))} ${esc(fmtTime(t.t_created, t.created_at, "short"))}${t.evidence ? " · evidence: " + esc(t.evidence) : ""}${t.requires_review ? (t.reviewed ? " · reviewed" : " · needs an approved review to close") : ""}</div>
  </form>
  <h4>Timeline</h4><ul class="tl">${d.history.map(historyLine).join("")}</ul>
  <h4>Messages about it (${d.messages.length})</h4><ul class="tl">${d.messages.slice().reverse().map(messageLine).join("") || "<li>none tagged with this task</li>"}</ul>
  <h4>Reviews (${d.reviews.length})</h4><ul class="tl">${d.reviews.map((r) => `<li><span class="when">${esc(fmtTime(r.t, r.ts, "short"))}</span><b>${esc(r.verdict)}</b> by ${esc(nameOf(r.reviewer || r.by))}${r.what ? " — " + esc(r.what) : ""}</li>`).join("") || "<li>none</li>"}</ul>`;
  $("#detail-form").onsubmit = (e) => { e.preventDefault(); saveDetail(t, new FormData(e.target)); };
  $("#waive")?.addEventListener("click", async () => {
    const reason = prompt("Why ship it without a review? (recorded with the waiver)"); if (reason === null) return;
    try { await api("/api/task", { action: "waive", id: t.id, reason }); toast("review waived"); await refresh(); render(); openDetail(t.id); }
    catch (err) { toast(err.message, true); }
  });
}

function historyLine(e) {
  const skip = new Set(["id", "kind", "ts", "t", "by", "created_by"]);
  const keys = Object.keys(e).filter((k) => !skip.has(k));
  const what = e.kind === "created" ? `created${e.owner ? " for " + esc(nameOf(e.owner)) : ""}` :
    keys.length === 1 && keys[0] === "rank" ? "reordered on the board" :
    e.kind === "swept" ? (e.check_after ? `reminder re-armed for ${esc(e.check_after)}` : "reminder delivered") :
    Object.entries(e).filter(([k, v]) => !skip.has(k) && v !== undefined)
      .map(([k, v]) => `${esc(k)} → ${esc(k === "owner" ? nameOf(v) : typeof v === "object" ? JSON.stringify(v) : v)}`).join(", ");
  const by = e.by || e.created_by;
  return `<li><span class="when">${esc(fmtTime(e.t, e.ts, "short"))}</span>${by ? esc(nameOf(by)) + ": " : ""}${what}</li>`;
}
function messageLine(m) {
  const where = m.channel ? chatURL("channel=" + encodeURIComponent(m.channel)) :
    chatURL("dm=" + encodeURIComponent(m.from === "user" ? m.to : m.from));
  const label = m.channel ? "#" + m.channel : `${nameOf(m.from)} → ${nameOf(m.to)}`;
  return `<li><span class="when">${esc(fmtTime(m.t, m.ts, "short"))}</span><a href="${where}">${esc(label)}</a>
    ${m.kind && m.kind !== "work" ? `<span class="badge quiet">${esc(m.kind)}</span>` : ""} ${esc((m.content || "").slice(0, 200))}</li>`;
}

function linkHTML(l) {
  const h = href(escHTML(l.url));
  return h ? `<a class="bookmark" href="${h}" target="_blank" rel="noopener" title="${esc(l.url)}">🔗 ${esc(l.title)}</a>`
           : `<span class="bookmark" title="${esc(l.url)}">📄 ${esc(l.title)}</span>`;
}
function tokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0); }
function usageHTML(u) {
  if (!u || !u.tokens) return `<div class="hint" style="margin-top:6px">No tokens recorded for it yet.</div>`;
  const by = Object.entries(u.agents || {}).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${esc(nameOf(a))} ${tokens(n)}`).join(", ");
  return `<div class="usage"><b>${tokens(u.tokens)} tokens</b> over ${u.turns} turn${u.turns === 1 ? "" : "s"} (${tokens(u.input_tokens)} in, ${tokens(u.output_tokens)} out) — ${by}
    <div class="hint">${u.direct} turn${u.direct === 1 ? "" : "s"} woken by a message naming it; ${u.inferred} counted because the agent was working on it. An estimate.</div></div>`;
}

async function saveDetail(t, fd) {
  const linksBefore = (t.links || []).map((l) => l.title && l.title !== l.url ? `${l.title} | ${l.url}` : l.url).join("\n");
  const linksNow = String(fd.get("links") || "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  if (linksNow !== linksBefore) {
    const links = linksNow ? linksNow.split("\n").map((l) => { const [a, ...r] = l.split("|"); return r.length ? { title: a.trim(), url: r.join("|").trim() } : { url: a.trim() }; }) : [];
    try { await api("/api/bookmarks", { task: t.id, bookmarks: links }); } catch (err) { return toast(err.message, true); }
  }
  const change = {};
  for (const k of ["title", "status", "owner", "project", "channel", "deadline", "note"]) {
    const v = (fd.get(k) ?? "").toString();
    if (v !== (t[k] || "")) change[k] = v;
  }
  if (!Object.keys(change).length) {
    if (linksNow !== linksBefore) { toast("links saved"); await refresh(); render(); return openDetail(t.id); }
    return toast("nothing changed");
  }
  if (change.deadline === "") return toast("clearing a deadline is not supported yet", true);
  try {
    if (change.status === "done" && t.requires_review && !t.reviewed) return toast("needs an approved review first, or Waive review", true);
    await api("/api/task", { action: "update", id: t.id, ...change });
    toast("saved" + (t.owner || change.owner ? " — the owner was told of status and owner changes" : ""));
    await refresh(); render(); openDetail(t.id);
  } catch (err) { toast(err.message, true); }
}

function closeDetail() {
  S.selected = null; history.replaceState(null, "", location.pathname + location.search);
  $("#detail").classList.add("hidden"); $("#detail-split").classList.add("hidden");
  document.querySelectorAll(".card.selected").forEach((c) => c.classList.remove("selected"));
}

// --- making one -----------------------------------------------------------------

function newTask() {
  const projects = [...new Set(S.tasks.map((t) => t.project).filter(Boolean))].sort();
  const chans = Object.entries(S.state.channels || {}).filter(([, c]) => !c.archived).map(([n]) => n).sort();
  $("#modal-card").innerHTML = `<form><h3>New task</h3>
    <label>Title</label><input type="text" name="title" required>
    <label>Project</label><input type="text" name="project" list="projects" value="${esc($("#project").value || projects[0] || "")}" required>
    <datalist id="projects">${projects.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
    <label>Owner</label><select name="owner"><option value="">nobody yet</option>${S.state.agents.map((a) => `<option value="${esc(a.name)}">${esc(nameOf(a.name))}</option>`).join("")}</select>
    <label>Channel</label><select name="channel"><option value="">none</option>${chans.map((n) => `<option>${esc(n)}</option>`).join("")}</select>
    <label>Column</label><select name="status"><option value="queued">To do</option><option value="icebox">Icebox</option></select>
    <label>Note</label><textarea name="note" rows="3" style="width:100%"></textarea>
    <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="rr"> requires an approved review to close</label>
    <div class="modal-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn">Create</button></div></form>`;
  $("#modal").classList.remove("hidden");
  const form = $("#modal-card form"); form.querySelector("input").focus();
  form.querySelector("[data-cancel]").onclick = () => $("#modal").classList.add("hidden");
  form.onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(form);
    try {
      const t = await api("/api/task", { action: "create", title: fd.get("title"), project: fd.get("project"),
        owner: fd.get("owner") || null, channel: fd.get("channel") || null, status: fd.get("status"),
        note: fd.get("note"), requires_review: !!fd.get("rr") });
      $("#modal").classList.add("hidden"); toast(`created ${t.id}`);
      await refresh(); render(); openDetail(t.id);
    } catch (err) { toast(err.message, true); }
  };
}

// --- live, and the rest -------------------------------------------------------------

function listen() {
  if (S.events) S.events.close();
  S.events = new EventSource(`/api/events?${q({})}`);
  let later = null;
  S.events.onmessage = (ev) => {
    const { stream, item } = JSON.parse(ev.data);
    if (stream === "bus" && !item.task_id) return;
    clearTimeout(later);
    later = setTimeout(async () => {
      if (S.drag) return;
      await refresh().catch(() => {}); render();
      if (S.selected && !document.activeElement?.closest?.("#detail-form")) openDetail(S.selected);
    }, 400);
  };
  S.events.onerror = () => { setTimeout(() => { if (S.events.readyState === 2) listen(); }, 3000); };
}

function saveBoardPrefs() { save(`agyboard.prefs.${S.team}`, { lanes: $("#lanes").value, closed: $("#show-closed").checked }); }
$("#detail-close").onclick = closeDetail;
$("#team").onchange = (e) => { S.team = e.target.value; closeDetail(); openTeam(); };
for (const id of ["#owner", "#project"]) $(id).onchange = render;
$("#filter").oninput = render;
$("#lanes").onchange = () => { saveBoardPrefs(); render(); };
$("#show-closed").onchange = () => { saveBoardPrefs(); render(); };
$("#new-task").onclick = newTask;
window.addEventListener("hashchange", () => { const id = new URLSearchParams(location.hash.slice(1)).get("task"); if (id && id !== S.selected) openDetail(id); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#modal").classList.add("hidden"); closeDetail(); } });

// The detail drawer is as wide as you leave it.
const W = load("agyboard.detail", null); if (W) $("#detail").style.width = W + "px";
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#detail-split")) return; e.preventDefault();
  const move = (ev) => { const w = Math.max(320, Math.min(900, innerWidth - ev.clientX)); $("#detail").style.width = w + "px"; save("agyboard.detail", w); };
  const up = () => { removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
  addEventListener("mousemove", move); addEventListener("mouseup", up);
});

loadTeams().catch((e) => toast(e.message, true));

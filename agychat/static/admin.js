/* agy-chat's admin page: agents, norms, memories, update and restart.
   Reads and writes go through the server, which goes through agyteam.actions. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const S = { teams: [], team: null, admin: null, tab: "agents", memories: [], updatePoll: null };

function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const list = (v) => Array.isArray(v) ? v.join(", ") : (v || "");

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

function modal(html, onSubmit) {
  $("#modal-card").innerHTML = `<form>${html}<div class="modal-actions"><button type="button" class="btn ghost" data-cancel>Cancel</button><button class="btn">Save</button></div></form>`;
  $("#modal").classList.remove("hidden");
  const form = $("#modal-card form");
  form.querySelector("[data-cancel]").onclick = () => $("#modal").classList.add("hidden");
  form.onsubmit = async (e) => { e.preventDefault(); try { await onSubmit(new FormData(form)); $("#modal").classList.add("hidden"); } catch (err) { toast(err.message, true); } };
  form.querySelector("input,textarea")?.focus();
}

// --- tabs and team ------------------------------------------------------------------

function showTab(tab) {
  S.tab = tab; save("agychat.adminTab", tab);
  document.querySelectorAll(".admin-tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${tab}`));
  history.replaceState(null, "", `?team=${encodeURIComponent(S.team)}#${tab}`);
  if (tab === "memories") loadMemories();
  if (tab === "update") refreshVersions();
}
document.querySelectorAll(".admin-tabs .tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

async function openTeam() {
  save("agychat.team", S.team);
  $("#chat-link").href = `/?team=${encodeURIComponent(S.team)}`;
  $("#board-link").href = `/board?team=${encodeURIComponent(S.team)}`;
  document.title = `${S.team} — admin — agy-chat`;
  S.admin = await api(`/api/admin?${q({})}`);
  renderAgents(); renderNorms();
  $("#mem-agent").innerHTML = S.admin.agents.map((a) => `<option>${esc(a.name)}</option>`).join("");
  showTab(S.tab);
}
$("#team").onchange = (e) => { S.team = e.target.value; openTeam(); };

// --- agents -------------------------------------------------------------------------

function renderAgents() {
  $("#agents").innerHTML = S.admin.agents.map((a) => `<tr data-name="${esc(a.name)}">
    <td class="name">${esc(a.name)}</td>
    <td data-label="Role"><input type="text" data-f="role" value="${esc(a.role)}"></td>
    <td data-label="Default model"><input type="text" data-f="model" value="${esc(a.model)}" placeholder="runner default"></td>
    <td data-label="Principal"><input type="checkbox" data-f="is_principal" ${a.is_principal ? "checked" : ""} title="Faces the user and gates what reaches them"></td>
    <td data-label="Tools off"><input type="text" data-f="tools_off" value="${esc(list(a.tools_off))}" placeholder="none"></td>
    <td data-label="Aliases"><input type="text" data-f="aliases" value="${esc(list(a.aliases))}" placeholder="none"></td>
    <td class="row-actions"><button class="btn small hidden" data-act="save">Save</button>
      <button class="btn small ghost" data-act="remove">Remove</button></td></tr>`).join("")
    || `<tr><td colspan="7" class="sub">No agents on the roster.</td></tr>`;
}
$("#agents").addEventListener("input", (e) => {
  const tr = e.target.closest("tr"); tr.classList.add("dirty"); tr.querySelector("[data-act=save]").classList.remove("hidden");
});
$("#agents").addEventListener("click", async (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  const tr = btn.closest("tr"); const name = tr.dataset.name;
  try {
    if (btn.dataset.act === "save") {
      const body = { action: "update", name };
      tr.querySelectorAll("[data-f]").forEach((el) => { body[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value; });
      await api("/api/agent", body);
      toast(`${name} saved`);
    } else if (btn.dataset.act === "remove") {
      if (!confirm(`Remove ${name} from the team? A turn it is running is cancelled. Its memories and history stay on disk; adding it back by the same name picks them up.`)) return;
      await api("/api/agent", { action: "remove", name });
      toast(`${name} removed`);
    }
    await openTeam();
  } catch (err) { toast(err.message, true); }
});
$("#add-agent").onsubmit = async (e) => {
  e.preventDefault(); const fd = new FormData(e.target);
  try {
    const r = await api("/api/agent", { action: "add", name: fd.get("name"), role: fd.get("role"),
                                         model: fd.get("model"), all_channels: !!fd.get("all_channels") });
    toast(`${r.name} added` + (r.channels?.length ? ` to ${r.channels.map((c) => "#" + c).join(", ")}` : ""));
    e.target.reset(); await openTeam();
  } catch (err) { toast(err.message, true); }
};

// --- norms --------------------------------------------------------------------------

function renderNorms() {
  $("#norms").value = S.admin.norms || "";
  $("#norms-state").textContent = S.admin.norms ? "" : "No NORMS.md yet.";
}
$("#norms").oninput = () => { $("#norms-state").textContent = "unsaved changes"; };
$("#save-norms").onclick = async () => {
  try { await api("/api/norms", { text: $("#norms").value }); $("#norms-state").textContent = "saved"; toast("norms saved"); }
  catch (err) { toast(err.message, true); }
};

// --- memories -------------------------------------------------------------------------

async function loadMemories() {
  const agent = $("#mem-agent").value; if (!agent) { $("#memories").innerHTML = ""; return; }
  try { S.memories = (await api(`/api/memories?${q({ agent })}`)).memories; }
  catch (err) { toast(err.message, true); S.memories = []; }
  $("#memories").innerHTML = S.memories.map((m, i) => `<div class="card memory" data-i="${i}">
    <div class="head"><span class="name">${esc(m.name)}</span><span class="desc">${esc(m.description)}</span>
      <button class="btn small ghost" data-act="edit">Edit</button><button class="btn small ghost" data-act="delete">Delete</button></div>
    <pre>${esc(m.content)}</pre></div>`).join("") || `<p class="sub">${esc(agent)} has saved nothing yet.</p>`;
}
$("#mem-agent").onchange = loadMemories;
function memoryModal(m) {
  const agent = $("#mem-agent").value;
  modal(`<h3>${m ? "Edit" : "New"} memory for ${esc(agent)}</h3>
    <label>Name</label><input type="text" name="name" value="${esc(m?.name)}" ${m ? "readonly" : "required"}>
    <label>One-line description</label><input type="text" name="description" value="${esc(m?.description)}">
    <label>Content</label><textarea name="content" rows="10" required>${esc(m?.content)}</textarea>`,
    async (fd) => {
      await api("/api/memory", { action: "save", agent, name: fd.get("name"), description: fd.get("description"), content: fd.get("content") });
      toast("memory saved"); await loadMemories();
    });
}
$("#new-memory").onclick = () => memoryModal(null);
$("#memories").addEventListener("click", async (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  const m = S.memories[+btn.closest(".memory").dataset.i]; const agent = $("#mem-agent").value;
  if (btn.dataset.act === "edit") return memoryModal(m);
  if (!confirm(`Delete ${agent}'s memory "${m.name}"?`)) return;
  try { await api("/api/memory", { action: "delete", agent, name: m.name }); toast("deleted"); await loadMemories(); }
  catch (err) { toast(err.message, true); }
});

// --- update and restart ---------------------------------------------------------------

function teamState(t) {
  if (!t.running) return `<span class="sub">not running</span>`;
  if (t.draining) return `<span class="state-warn">draining — waiting for ${esc(t.inflight.join(", ") || "the restart")}</span>`;
  return `<span class="state-ok">running</span>${t.version ? ` on ${esc(t.version)}` : ` <span class="state-warn">(older than graceful restart)</span>`}`;
}
async function refreshVersions() {
  let v;
  try { v = await api("/api/versions"); }
  catch { $("#versions").innerHTML = `<span class="state-warn">agy-chat is restarting…</span>`; return false; }
  $("#versions").innerHTML = `<table class="vers"><tr><td>agy-chat</td><td>${esc(v.agychat)}</td></tr>
    <tr><td>agy-team (this app)</td><td>${esc(v.agyteam)}</td></tr>
    ${v.teams.map((t) => `<tr><td>team ${esc(t.name)}</td><td>${teamState(t)}</td><td>${t.running
      ? `<button class="btn small ghost" data-restart="${esc(t.name)}" ${t.draining ? "disabled" : ""}>Restart</button>` : ""}</td></tr>`).join("")}</table>`;
  $("#log").textContent = (v.log || []).join("\n") || "(nothing yet)";
  $("#run-update").disabled = v.update.state === "running" || v.update.state === "restarting";
  return v;
}
$("#versions").addEventListener("click", async (e) => {
  const team = e.target.closest("[data-restart]")?.dataset.restart; if (!team) return;
  const now = $("#now").checked;
  if (!confirm(`Restart ${team}'s supervisor on the installed code? ${now ? "Turns in flight are cancelled and their mail goes back." : "It starts no new turns and restarts when the ones in flight finish."}`)) return;
  try { await api("/api/supervisor", { team, action: "restart", now }); toast(`${team}: restart requested`); refreshVersions(); }
  catch (err) { toast(err.message, true); }
});
$("#check").onclick = async () => {
  const out = $("#check-out"); out.classList.remove("hidden"); out.textContent = "checking…";
  try {
    const r = await api("/api/update", { action: "check" });
    const say = (p) => !p ? "unknown" : p.error ? p.error
      : p.kind === "git" ? `${p.repo}: ${p.behind ? `${p.behind} new commit(s) on ${p.upstream}` : "up to date"}${p.dirty ? " (has local changes: update will refuse)" : ""}`
      : p.kind === "git-tag" ? `${p.repo}: ${p.current || "untagged"} → ${p.target}`
      : p.kind === "pip" ? `pip install from ${p.url}: newest ${p.target}` : "installed some other way";
    out.textContent = `agy-chat: ${say(r.agychat)}\nagy-team: ${r.agyteam_shares_this_env ? "comes with agy-chat" : say(r.agyteam)}`;
  } catch (err) { out.textContent = err.message; }
};
$("#run-update").onclick = async () => {
  const now = $("#now").checked;
  if (!confirm(`Update agy-team and agy-chat, then restart every running team${now ? ", cancelling turns in flight" : " gracefully"}, then agy-chat?`)) return;
  try { await api("/api/update", { action: "run", now }); toast("updating…"); watchUpdate(); }
  catch (err) { toast(err.message, true); }
};
function watchUpdate() {
  clearInterval(S.updatePoll);
  let restarting = false;
  S.updatePoll = setInterval(async () => {
    const v = await refreshVersions();
    if (v && v.update.state === "restarting") restarting = true;
    if (v && restarting && v.update.state === "idle") { clearInterval(S.updatePoll); toast("updated"); setTimeout(() => location.reload(), 600); }
    if (v && v.update.state === "error") { clearInterval(S.updatePoll); toast(v.update.error || "update failed", true); }
  }, 1500);
}

// --- start ----------------------------------------------------------------------------

(async () => {
  try {
    const { teams } = await api("/api/teams");
    S.teams = teams;
    $("#team").innerHTML = teams.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
    const asked = new URLSearchParams(location.search).get("team");
    const want = asked || load("agychat.team", null);
    S.team = teams.some((t) => t.name === want) ? want : teams[0]?.name;
    $("#team").value = S.team;
    S.tab = (location.hash || "").slice(1) || load("agychat.adminTab", "agents");
    if (!["agents", "norms", "memories", "update"].includes(S.tab)) S.tab = "agents";
    if (S.team) await openTeam();
    const v = await refreshVersions();
    if (v && v.update.state === "running") watchUpdate();
  } catch (err) { toast(err.message, true); }
})();

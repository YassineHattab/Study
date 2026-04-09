import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  collection,
  collectionGroup,
  onSnapshot,
  deleteDoc,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ─── Firebase ──────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyA1o71phhYPK0MQE2NNHW1dV5-FratujdY",
  authDomain: "studypro-yas.firebaseapp.com",
  projectId: "studypro-yas",
  storageBucket: "studypro-yas.firebasestorage.app",
  messagingSenderId: "676258961640",
  appId: "1:676258961640:web:04283aa4089aff253d915d",
  measurementId: "G-WSW0QMPRJK",
};

const DATA_KEYS = [
  "studypro_sessions",
  "studypro_tasks",
  "studypro_settings",
  "studypro_timer_state",
  "studypro_music_custom",
];
const ALL_KEYS = [...DATA_KEYS, "studypro_day_notes"];

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Firebase native persistence — no manual cache needed
setPersistence(auth, browserLocalPersistence).catch(console.warn);

// ─── Global state (single source of truth) ────────────────────────────────
const state = {
  uid:              null,
  user:             null,
  cache:            {},
  totalStudyMinutes: 0,    // cumulative study minutes, loaded from Firestore
};

// ─── Timer tracking (real-time minute accumulator) ─────────────────────────
let _timerInterval   = null;   // setInterval for per-minute save
let _statsObserver   = null;   // MutationObserver for stats section injection

// ─── Admin & Medals config ─────────────────────────────────────────────────
const ADMIN_EMAIL = "yassihatta@gmail.com";

const AUTO_MEDALS = [
  {
    id: "auto_first_session",
    emoji: "⏱️", title: "Premier Focus",
    description: "Tu as complété ta première session Pomodoro !",
    check: () => { try { return JSON.parse(state.cache["studypro_sessions"] || "[]").length > 0; } catch { return false; } },
  },
  {
    id: "auto_pomodoro_master",
    emoji: "🔥", title: "Maître du Pomodoro",
    description: "Tu as complété 10 sessions Pomodoro !",
    check: () => { try { return JSON.parse(state.cache["studypro_sessions"] || "[]").length >= 10; } catch { return false; } },
  },
  {
    id: "auto_first_note",
    emoji: "📝", title: "Première Note",
    description: "Tu as rédigé ta première note de cours !",
    check: () => { try { return Object.keys(JSON.parse(state.cache["studypro_day_notes"] || "{}")).length > 0; } catch { return false; } },
  },
  {
    id: "auto_first_task",
    emoji: "✅", title: "Organisé",
    description: "Tu as ajouté tes premières tâches !",
    check: () => { try { return JSON.parse(state.cache["studypro_tasks"] || "[]").length > 0; } catch { return false; } },
  },
  // ── Study-time milestone medals (checked against live Firestore accumulator) ──
  {
    id: "auto_10h_study",
    emoji: "🥇", title: "Badge Or — 10h étudiées",
    description: "Tu as atteint 10 heures d'étude au total !",
    check: () => (state.totalStudyMinutes || 0) >= 600,
  },
  {
    id: "auto_50h_study",
    emoji: "💎", title: "Badge Diamant — 50h étudiées",
    description: "Tu as atteint 50 heures d'étude au total !",
    check: () => (state.totalStudyMinutes || 0) >= 3000,
  },
  {
    id: "auto_100h_study",
    emoji: "💚", title: "Badge Émeraude — 100h étudiées",
    description: "Tu as atteint 100 heures d'étude au total !",
    check: () => (state.totalStudyMinutes || 0) >= 6000,
  },
];

const ADMIN_MEDALS = [
  { id: "admin_major_promo",      emoji: "🏆", title: "Major de Promo",         description: "Le meilleur de la promotion !" },
  { id: "admin_expert_anatomie",  emoji: "🩺", title: "Expert Anatomie",         description: "Maîtrise parfaite de l'anatomie !" },
  { id: "admin_assiduite",        emoji: "⭐", title: "Assiduité Exemplaire",    description: "Présent et motivé chaque jour !" },
  { id: "admin_courage",          emoji: "💪", title: "Courage",                 description: "Ne lâche jamais !" },
  { id: "admin_meilleur_etudiant",emoji: "🎓", title: "Meilleur Étudiant",       description: "Félicitations pour tes résultats !" },
];

// ─── Evolution tiers ───────────────────────────────────────────────────────
// minMinutes are the EXACT thresholds: 600=10h, 3000=50h, 6000=100h, 30000=500h
const TIERS = [
  { name: "Débutant",  emoji: "🌱", minMinutes: 0,     color: "#64748b" },
  { name: "Or",        emoji: "🥇", minMinutes: 600,   color: "#f59e0b" },
  { name: "Diamant",   emoji: "💎", minMinutes: 3000,  color: "#3b82f6" },
  { name: "Émeraude",  emoji: "💚", minMinutes: 6000,  color: "#10b981" },
  { name: "Rubis",     emoji: "❤️", minMinutes: 30000, color: "#ef4444" },
];

function _getCurrentTier(totalMinutes) {
  let tier = TIERS[0];
  for (const t of TIERS) { if (totalMinutes >= t.minMinutes) tier = t; else break; }
  return tier;
}

function _getNextTier(totalMinutes) {
  for (const t of TIERS) { if (totalMinutes < t.minMinutes) return t; }
  return null;
}

// Diagnostic: logs current grade/progress to console
function _logTierState() {
  const m = state.totalStudyMinutes || 0;
  const cur  = _getCurrentTier(m);
  const next = _getNextTier(m);
  const nextLabel = next
    ? `${next.emoji} ${next.name} (${next.minMinutes} min / ${next.minMinutes/60}h)`
    : "🏆 Maximum atteint";
  console.log(`[studypro] 📊 Temps actuel : ${m} min | Grade : ${cur.emoji} ${cur.name} | Prochain : ${nextLabel}`);
}

// Detect when user crosses into a new tier and show a congratulation toast
let _lastTierName = null;
function _checkTierUp() {
  const cur = _getCurrentTier(state.totalStudyMinutes || 0);
  if (_lastTierName === null) { _lastTierName = cur.name; return; }
  if (cur.name !== _lastTierName) {
    _lastTierName = cur.name;
    _showToast(`${cur.emoji} Nouveau grade débloqué : ${cur.name} ! Félicitations !`, "success");
    _refreshStatsTier();
  }
}

function _getUserStudyMinutes() {
  // Prefer the Firestore-backed cumulative counter (updated every minute the timer runs)
  if (state.totalStudyMinutes > 0) return state.totalStudyMinutes;
  // Fallback: calculate from sessions array (for users who haven't accumulated yet)
  try {
    const arr = JSON.parse(state.cache["studypro_sessions"] || "[]");
    return _parseStudyMinutes(arr);
  } catch (_) { return 0; }
}

// Live copy of current user's medals (filled by onSnapshot)
let _userRewards = [];
// Live copy of all private messages for current user (read + unread)
let _userMessages = [];

// Message shown on login overlay after being blocked
let _blockedMessage = "";

// Cached role/status of current user
let _userRole   = "";   // '' | 'admin'
let _userStatus = "";   // '' | 'blocked'

// Guard flag — set to true after sign-up email is sent so the button
// re-click triggers a verification check, never a second createUser call
let _signupWaiting = false;

// Single verification poll interval — cleared before any new one is started
let _verifyPollId = null;

// ─── Listener management (prevents stale-listener race condition) ──────────
// Every call to _initUserData gets a unique ID. Only the most recent call
// is allowed to set listeners; older in-flight calls are aborted.
let _currentInitId  = 0;
let _activeListeners = [];   // array of { uid, unsub } — all live Firestore listeners

function _cancelAllListeners() {
  _activeListeners.forEach(({ unsub }) => { try { unsub(); } catch (_) {} });
  _activeListeners = [];
  console.log("[studypro] All Firestore listeners cancelled.");
}

function _registerListener(uid, unsub) {
  _activeListeners.push({ uid, unsub });
}

// ─── localStorage proxy ────────────────────────────────────────────────────
const _oGet = Storage.prototype.getItem;
const _oSet = Storage.prototype.setItem;
const _oDel = Storage.prototype.removeItem;

Storage.prototype.getItem = function (key) {
  if (this === window.localStorage && ALL_KEYS.includes(key)) {
    return key in state.cache ? state.cache[key] : null;
  }
  return _oGet.call(this, key);
};

Storage.prototype.setItem = function (key, value) {
  if (this === window.localStorage && ALL_KEYS.includes(key)) {
    state.cache[key] = value;
    if (state.uid) _syncToFirestore(state.uid, key, value);
    return;
  }
  _oSet.call(this, key, value);
};

Storage.prototype.removeItem = function (key) {
  if (this === window.localStorage && ALL_KEYS.includes(key)) {
    delete state.cache[key];
    if (state.uid) _deleteFromFirestore(state.uid, key);
    return;
  }
  _oDel.call(this, key);
};

// ─── Firestore writes ──────────────────────────────────────────────────────
async function _syncToFirestore(uid, key, value) {
  try {
    if (key === "studypro_day_notes") {
      let parsed = {};
      try { parsed = JSON.parse(value); } catch (_) {}
      const existing = await getDocs(collection(db, "users", uid, "notes"));
      const ops = [];
      existing.forEach((d) => {
        if (!(d.id in parsed)) ops.push(deleteDoc(d.ref));
      });
      Object.entries(parsed).forEach(([date, content]) =>
        ops.push(setDoc(doc(db, "users", uid, "notes", date), { content }))
      );
      await Promise.all(ops);
      console.log("[studypro] Note enregistrée dans Firestore pour UID:", uid);
    } else {
      await setDoc(doc(db, "users", uid, "data", key), { value });
      console.log("[studypro] Données enregistrées dans Firestore pour UID:", uid, "| clé:", key);
    }
  } catch (e) {
    if (e.code === "permission-denied") _showPermissionToast();
    else console.warn("[studypro] Firestore write error:", key, e);
  }
}

async function _deleteFromFirestore(uid, key) {
  try {
    if (key === "studypro_day_notes") {
      const snap = await getDocs(collection(db, "users", uid, "notes"));
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    }
  } catch (e) { console.warn("[studypro] Firestore delete error:", key, e); }
}

// ─── User Profile ─────────────────────────────────────────────────────────
async function _writeUserProfile(user) {
  try {
    await setDoc(doc(db, "userProfiles", user.uid), {
      uid:         user.uid,
      email:       user.email || "",
      displayName: user.displayName || "",
      photoURL:    user.photoURL || "",
      lastSeen:    Date.now(),
    }, { merge: true });
  } catch (e) { console.warn("[studypro] Profile write error:", e); }
}

// ─── Rewards listener (real-time) ─────────────────────────────────────────
function _listenToRewards(uid, initId) {
  const unsub = onSnapshot(
    collection(db, "users", uid, "rewards"),
    (snap) => {
      if (initId !== _currentInitId) { try { unsub(); } catch (_) {} return; }
      const prev = _userRewards.length;
      _userRewards = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Blocking modal for unread admin medals (shown even if timer is running)
      _userRewards.filter(r => r.unread).forEach(r => _showUnreadMedalModal(r, uid));

      // Non-blocking toast only for newly earned non-unread medals
      if (_userRewards.length > prev && prev >= 0 && document.getElementById("root").style.opacity === "1") {
        const newest = _userRewards[_userRewards.length - 1];
        if (!newest.unread) _showMedalNotification(newest);
      }
      _refreshRewardsPanel();
    },
    (e) => console.warn("[studypro] Rewards listener error:", e)
  );
  _registerListener(uid, unsub);
}

// ─── Blocking unread-medal modal ───────────────────────────────────────────
function _showUnreadMedalModal(medal, uid) {
  if (document.getElementById(`sp-medal-modal-${medal.id}`)) return;
  const modal = document.createElement("div");
  modal.id = `sp-medal-modal-${medal.id}`;
  modal.className = "sp-medal-modal";
  modal.innerHTML = `
    <div class="sp-medal-modal-card">
      <div class="sp-medal-modal-confetti">🎉</div>
      <div class="sp-medal-modal-emoji">${medal.emoji}</div>
      <div class="sp-medal-modal-title">Nouvelle récompense !</div>
      <div class="sp-medal-modal-name">${medal.title}</div>
      <div class="sp-medal-modal-desc">${medal.description}</div>
      ${medal.awardedBy ? `<div class="sp-medal-modal-from">Envoyée par ${medal.awardedBy}</div>` : ""}
      <button class="sp-medal-modal-btn" id="sp-medal-ok-${medal.id}">
        Merci ! 🙌
      </button>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => { requestAnimationFrame(() => modal.classList.add("sp-medal-modal--show")); });
  document.getElementById(`sp-medal-ok-${medal.id}`).addEventListener("click", async () => {
    modal.classList.remove("sp-medal-modal--show");
    setTimeout(() => modal.remove(), 320);
    try {
      await updateDoc(doc(db, "users", uid, "rewards", medal.id), { unread: false });
    } catch (e) { console.warn("[studypro] Medal read update error:", e); }
  });
}

// ─── Auto Medals ──────────────────────────────────────────────────────────
async function _checkAutoMedals(uid) {
  const existing = new Set(_userRewards.map(r => r.id));
  for (const medal of AUTO_MEDALS) {
    if (existing.has(medal.id)) continue;
    if (medal.check()) {
      await _awardMedal(uid, {
        id: medal.id, emoji: medal.emoji,
        title: medal.title, description: medal.description,
        type: "auto", awardedAt: Date.now(),
      });
    }
  }
}

async function _awardMedal(uid, medal) {
  try {
    // Admin medals arrive as unread (triggers blocking modal for the recipient)
    const data = medal.type === "admin" ? { ...medal, unread: true } : medal;
    await setDoc(doc(db, "users", uid, "rewards", medal.id), data);
    console.log("[studypro] 🏅 Medal awarded:", medal.title, "→ uid:", uid);
  } catch (e) { console.warn("[studypro] Medal award error:", e); }
}

// ─── Medal notification toast ──────────────────────────────────────────────
function _showMedalNotification(medal) {
  const n = document.createElement("div");
  n.className = "medal-notif";
  n.innerHTML = `
    <div class="medal-notif-emoji">${medal.emoji}</div>
    <div class="medal-notif-body">
      <div class="medal-notif-top">Nouvelle médaille débloquée !</div>
      <div class="medal-notif-name">${medal.title}</div>
    </div>
  `;
  document.body.appendChild(n);
  requestAnimationFrame(() => { requestAnimationFrame(() => n.classList.add("medal-notif--show")); });
  setTimeout(() => {
    n.classList.remove("medal-notif--show");
    setTimeout(() => n.remove(), 420);
  }, 4500);
}

// ─── Rewards panel ─────────────────────────────────────────────────────────
function _closeAllPanels() {
  document.getElementById("sp-panel")?.remove();
}

function _showRewardsPanel() {
  _closeAllPanels();
  _closeDropdown();
  const el = document.createElement("div");
  el.id = "sp-panel";
  el.className = "sp-panel";
  el.innerHTML = `
    <div class="sp-panel-card">
      <div class="sp-panel-header">
        <h2 class="sp-panel-title">🏅 Mes Trophées</h2>
        <button class="sp-panel-close" id="sp-panel-close">×</button>
      </div>
      <div id="sp-rewards-content">${_renderRewards()}</div>
    </div>
  `;
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  document.getElementById("sp-panel-close", el)?.addEventListener?.("click", () => el.remove());
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("sp-panel--open"));
  el.querySelector("#sp-panel-close").addEventListener("click", () => el.remove());
}

// Inner content shared between Trophées panel and Stats section injection
function _renderTierProgressInline() {
  const totalMinutes = _getUserStudyMinutes();
  const cur  = _getCurrentTier(totalMinutes);
  const next = _getNextTier(totalMinutes);
  const timeStr = _formatStudyTime(totalMinutes);

  let barHtml = "";
  if (next) {
    // Progress between current tier floor and next tier ceiling (in minutes)
    const range    = next.minMinutes - cur.minMinutes;
    const progress = totalMinutes - cur.minMinutes;
    const pct      = Math.min(100, Math.max(0, (progress / range) * 100));
    const remaining = next.minMinutes - totalMinutes;
    barHtml = `
      <div class="tier-bar-wrap">
        <div class="tier-bar-fill" style="width:${pct.toFixed(1)}%;background:${cur.color}"></div>
      </div>
      <div class="tier-next-info">
        Prochain : ${next.emoji} ${next.name} —
        encore ${_formatStudyTime(remaining)}
        &nbsp;·&nbsp; ${_formatStudyTime(totalMinutes)} / ${_formatStudyTime(next.minMinutes)}
      </div>`;
  } else {
    barHtml = `<div class="tier-next-info">🏆 Grade maximum atteint !</div>`;
  }

  return `
    <div class="tier-row">
      <div class="tier-emoji-big">${cur.emoji}</div>
      <div class="tier-info">
        <div class="tier-grade-name">${cur.name}</div>
        <div class="tier-time-label">${timeStr} d'étude</div>
      </div>
      <div class="tier-all">
        ${TIERS.map(t => `<span class="tier-pip ${totalMinutes >= t.minMinutes ? "tier-pip--on" : ""}"
          title="${t.name} (${_formatStudyTime(t.minMinutes)})">${t.emoji}</span>`).join("")}
      </div>
    </div>
    ${barHtml}`;
}

// With outer card wrapper (used in Trophées panel)
function _renderTierProgress() {
  return `<div class="tier-card">${_renderTierProgressInline()}</div>`;
}

function _renderRewardCard(r) {
  return `
    <div class="sp-reward-card">
      <div class="sp-reward-emoji">${r.emoji}</div>
      <div class="sp-reward-title">${r.title}</div>
      <div class="sp-reward-desc">${r.description}</div>
      ${r.type === "admin" ? `<div class="sp-reward-badge">Admin</div>` : ""}
    </div>`;
}

function _renderRewards() {
  const adminRewards = _userRewards.filter(r => r.type === "admin");
  const autoRewards  = _userRewards.filter(r => r.type !== "admin");

  if (_userRewards.length === 0) {
    return `<div class="sp-empty">
      <div style="font-size:52px;margin-bottom:10px">🌟</div>
      <div>Aucun trophée pour l'instant.</div>
      <div style="font-size:12px;margin-top:6px;color:#94a3b8">Continue à étudier pour en gagner !</div>
    </div>`;
  }

  let html = "";
  if (adminRewards.length > 0) {
    html += `
      <div class="sp-rewards-section">
        <div class="sp-rewards-section-label">🏆 Trophées Admin</div>
        <div class="sp-rewards-grid">${adminRewards.map(_renderRewardCard).join("")}</div>
      </div>`;
  }
  if (autoRewards.length > 0) {
    html += `
      <div class="sp-rewards-section">
        <div class="sp-rewards-section-label">🎯 Mes Réalisations</div>
        <div class="sp-rewards-grid">${autoRewards.map(_renderRewardCard).join("")}</div>
      </div>`;
  }
  return html;
}

function _refreshRewardsPanel() {
  const c = document.getElementById("sp-rewards-content");
  if (c) c.innerHTML = _renderRewards();
  // Keep badge in dropdown in sync
  const badge = document.getElementById("ud-medal-count");
  if (badge) {
    if (_userRewards.length > 0) {
      badge.textContent = _userRewards.length;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }
}

// ─── Admin panel ───────────────────────────────────────────────────────────
async function _showAdminPanel() {
  _closeAllPanels();
  _closeDropdown();
  const el = document.createElement("div");
  el.id = "sp-panel";
  el.className = "sp-panel";
  el.innerHTML = `
    <div class="sp-panel-card sp-panel-card--wide">
      <div class="sp-panel-header">
        <h2 class="sp-panel-title">🎛️ Panneau de Contrôle</h2>
        <button class="sp-panel-close" id="sp-panel-close">×</button>
      </div>
      <div class="sp-admin-tabs" id="sp-admin-tabs">
        <button class="sp-tab sp-tab--active" data-tab="users">👥 Utilisateurs</button>
        ${state.user?.email === ADMIN_EMAIL ? `<button class="sp-tab" data-tab="team">🔑 Équipe</button>` : ""}
        <button class="sp-tab" data-tab="messages">📣 Messages</button>
      </div>
      <div id="sp-admin-content">
        <div class="sp-empty"><div style="font-size:28px">⏳</div>Chargement…</div>
      </div>
    </div>
  `;
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  el.querySelector("#sp-panel-close").addEventListener("click", () => el.remove());

  // Tab switching
  el.querySelectorAll(".sp-tab").forEach(tab => {
    tab.addEventListener("click", async () => {
      el.querySelectorAll(".sp-tab").forEach(t => t.classList.remove("sp-tab--active"));
      tab.classList.add("sp-tab--active");
      const t = tab.dataset.tab;
      if (t === "users")    await _loadAdminUsers();
      if (t === "team")     await _loadTeamPanel();
      if (t === "messages") await _loadMessagesPanel();
    });
  });

  requestAnimationFrame(() => el.classList.add("sp-panel--open"));
  await _loadAdminUsers();
}

// ─── Team management panel ─────────────────────────────────────────────────
async function _loadTeamPanel() {
  const content = document.getElementById("sp-admin-content");
  if (!content) return;
  content.innerHTML = `<div class="sp-empty"><div style="font-size:28px">⏳</div>Chargement de l'équipe…</div>`;
  try {
    const snap = await getDocs(collection(db, "userProfiles"));
    const admins = [], blocked = [];
    snap.forEach(d => {
      const u = { uid: d.id, ...d.data() };
      if (u.role === "admin")      admins.push(u);
      if (u.status === "blocked")  blocked.push(u);
    });

    content.innerHTML = `
      <div class="sp-team-section">
        <h3 class="sp-section-title">➕ Promouvoir un Admin Secondaire</h3>
        <div class="sp-team-input-row">
          <input class="sp-team-input" id="promote-email" type="email" placeholder="Email de l'utilisateur" />
          <button class="sp-team-btn sp-team-btn--promote" id="promote-btn">Promouvoir</button>
        </div>
        <div id="promote-msg" class="sp-team-msg"></div>
      </div>

      <div class="sp-team-section">
        <h3 class="sp-section-title">🔑 Admins Secondaires (${admins.length})</h3>
        <div id="admins-list">
          ${admins.length === 0
            ? `<div class="sp-empty-small">Aucun admin secondaire pour l'instant.</div>`
            : admins.map(u => `
              <div class="sp-team-row" id="team-row-${u.uid}">
                <span class="sp-team-name">${u.displayName || u.email || u.uid}</span>
                <span class="sp-team-email">${u.email || ""}</span>
                <button class="sp-team-action sp-team-action--remove" data-uid="${u.uid}" data-action="remove">
                  Retirer Admin
                </button>
                <button class="sp-team-action sp-team-action--block" data-uid="${u.uid}" data-action="block"
                  ${u.status === "blocked" ? "disabled" : ""}>
                  Bloquer
                </button>
              </div>`).join("")}
        </div>
      </div>

      <div class="sp-team-section">
        <h3 class="sp-section-title">⛔ Utilisateurs Bloqués (${blocked.length})</h3>
        <div id="blocked-list">
          ${blocked.length === 0
            ? `<div class="sp-empty-small">Aucun utilisateur bloqué.</div>`
            : blocked.map(u => `
              <div class="sp-team-row" id="blocked-row-${u.uid}">
                <span class="sp-team-name">${u.displayName || u.email || u.uid}</span>
                <span class="sp-team-email">${u.email || ""}</span>
                <button class="sp-team-action sp-team-action--unblock" data-uid="${u.uid}" data-action="unblock">
                  Débloquer
                </button>
              </div>`).join("")}
        </div>
      </div>`;

    // Promote
    document.getElementById("promote-btn").addEventListener("click", async () => {
      const email = document.getElementById("promote-email").value.trim().toLowerCase();
      const msg   = document.getElementById("promote-msg");
      if (!email) { msg.textContent = "⚠️ Entrez un email."; return; }
      if (email === ADMIN_EMAIL) { msg.textContent = "⚠️ Déjà admin principal."; return; }
      try {
        const q = query(collection(db, "userProfiles"), where("email", "==", email));
        const snap = await getDocs(q);
        if (snap.empty) { msg.textContent = "❌ Aucun compte trouvé avec cet email."; return; }
        const userDoc = snap.docs[0];
        await updateDoc(doc(db, "userProfiles", userDoc.id), { role: "admin" });
        msg.textContent = `✅ ${email} est maintenant Admin Secondaire.`;
        setTimeout(() => _loadTeamPanel(), 1200);
      } catch (e) { msg.textContent = `❌ Erreur : ${e.message}`; }
    });

    // Remove admin / Block
    content.querySelectorAll(".sp-team-action").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { uid, action } = btn.dataset;
        btn.disabled = true;
        try {
          if (action === "remove")  await updateDoc(doc(db, "userProfiles", uid), { role: "" });
          if (action === "block")   await updateDoc(doc(db, "userProfiles", uid), { status: "blocked" });
          if (action === "unblock") await updateDoc(doc(db, "userProfiles", uid), { status: "" });
          _showToast(action === "unblock" ? "✅ Utilisateur débloqué" : "✅ Action appliquée", "info", 2500);
          setTimeout(() => _loadTeamPanel(), 600);
        } catch (e) { _showToast(`❌ Erreur : ${e.message}`, "info", 3000); btn.disabled = false; }
      });
    });
  } catch (e) {
    content.innerHTML = `<div class="sp-empty">⚠️ Erreur : ${e.message}</div>`;
  }
}

// ─── Admin messaging panel ──────────────────────────────────────────────────
async function _loadMessagesPanel() {
  const content = document.getElementById("sp-admin-content");
  if (!content) return;

  // Load user list for private msg dropdown
  let profilesList = [];
  try {
    const snap = await getDocs(collection(db, "userProfiles"));
    snap.forEach(d => profilesList.push({ uid: d.id, ...d.data() }));
  } catch (_) {}

  content.innerHTML = `
    <div class="sp-team-section">
      <h3 class="sp-section-title">📣 Message Global (Bannière pour tous)</h3>
      <textarea class="sp-msg-textarea" id="global-msg-text" rows="3"
        placeholder="Entrez un message visible par tous les utilisateurs…"></textarea>
      <div class="sp-msg-btns-row">
        <button class="sp-team-btn sp-team-btn--promote" id="send-global-btn">Envoyer à tous</button>
        <button class="sp-team-btn sp-team-btn--remove" id="clear-global-btn">Effacer bannière</button>
      </div>
      <div id="global-msg-status" class="sp-team-msg"></div>
    </div>

    <div class="sp-team-section">
      <h3 class="sp-section-title">✉️ Message Privé</h3>
      <select class="sp-team-input" id="private-msg-uid">
        <option value="">— Choisir un utilisateur —</option>
        ${profilesList.map(u => `<option value="${u.uid}">${u.displayName || u.email || u.uid}</option>`).join("")}
      </select>
      <textarea class="sp-msg-textarea" id="private-msg-text" rows="3"
        placeholder="Message privé pour cet utilisateur…"></textarea>
      <button class="sp-team-btn sp-team-btn--promote" id="send-private-btn" style="margin-top:8px">
        Envoyer le message
      </button>
      <div id="private-msg-status" class="sp-team-msg"></div>
    </div>

    <div class="sp-team-section">
      <h3 class="sp-section-title">📋 Historique des messages envoyés</h3>
      <div id="msg-history-list"></div>
    </div>`;

  // Global message handlers
  document.getElementById("send-global-btn").addEventListener("click", async () => {
    const text = document.getElementById("global-msg-text").value.trim();
    const status = document.getElementById("global-msg-status");
    if (!text) { status.textContent = "⚠️ Entrez un message."; return; }
    try {
      await setDoc(doc(db, "siteConfig", "globalMessage"), {
        text, active: true, author: state.user?.email || ADMIN_EMAIL,
        timestamp: Date.now(),
      });
      status.textContent = "✅ Message global envoyé !";
    } catch (e) { status.textContent = `❌ Erreur : ${e.message}`; }
  });

  document.getElementById("clear-global-btn").addEventListener("click", async () => {
    const status = document.getElementById("global-msg-status");
    try {
      await setDoc(doc(db, "siteConfig", "globalMessage"), { active: false, text: "", timestamp: Date.now() });
      status.textContent = "✅ Bannière effacée.";
    } catch (e) { status.textContent = `❌ Erreur : ${e.message}`; }
  });

  // Private message handler
  document.getElementById("send-private-btn").addEventListener("click", async () => {
    const recipientUid = document.getElementById("private-msg-uid").value;
    const text = document.getElementById("private-msg-text").value.trim();
    const status = document.getElementById("private-msg-status");
    if (!recipientUid) { status.textContent = "⚠️ Choisissez un utilisateur."; return; }
    if (!text)         { status.textContent = "⚠️ Entrez un message."; return; }
    try {
      const msgId = `msg_${Date.now()}`;
      const msgData = {
        text, read: false,
        author: state.user?.email || ADMIN_EMAIL,
        timestamp: Date.now(),
      };
      await setDoc(doc(db, "users", recipientUid, "messages", msgId), msgData);
      status.textContent = "✅ Message privé envoyé !";
      document.getElementById("private-msg-text").value = "";
      // Refresh the history section
      await _loadMsgHistory(profilesList);
    } catch (e) { status.textContent = `❌ Erreur : ${e.message}`; }
  });

  // Load message history on panel open
  await _loadMsgHistory(profilesList);
}

// Loads & renders recent private message history in the admin Messages panel
async function _loadMsgHistory(profilesList) {
  const container = document.getElementById("msg-history-list");
  if (!container) return;
  container.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:4px 0">Chargement…</div>`;
  try {
    const allMessages = [];
    await Promise.all(profilesList.map(async (u) => {
      try {
        const snap = await getDocs(collection(db, "users", u.uid, "messages"));
        snap.forEach(d => allMessages.push({
          id: d.id, ...d.data(),
          recipientName: u.displayName || u.email || u.uid,
        }));
      } catch (_) {}
    }));
    allMessages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (allMessages.length === 0) {
      container.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:4px 0">Aucun message envoyé.</div>`;
      return;
    }
    container.innerHTML = allMessages.slice(0, 30).map(m => `
      <div class="sp-hist-msg">
        <div class="sp-hist-header">
          <span class="sp-hist-to">→ ${m.recipientName}</span>
          <span class="sp-hist-time">${_formatMsgTime(m.timestamp)}</span>
          <span class="sp-hist-status ${m.read ? 'sp-hist-status--read' : 'sp-hist-status--unread'}">
            ${m.read ? '✓ Lu' : '● Non lu'}
          </span>
        </div>
        <div class="sp-hist-text">${m.text}</div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = `<div style="color:#ef4444;font-size:12px">Erreur : ${e.message}</div>`;
  }
}

// ─── Time helpers ──────────────────────────────────────────────────────────
// Detect whether session durations are stored in seconds or minutes and convert.
// Heuristic: a single Pomodoro session is never > 4 hours (240 min).
// If any raw value > 240, it is almost certainly in seconds.
function _parseStudyMinutes(arr) {
  if (!arr || arr.length === 0) return 0;
  const pick = (x) => x.duration ?? x.focusDuration ?? x.elapsedTime ?? x.timeSpent ?? 0;
  const maxVal = Math.max(...arr.map(pick));
  const inSeconds = maxVal > 240; // values > 240 must be seconds
  const total = arr.reduce((sum, x) => sum + (pick(x) || (inSeconds ? 1500 : 25)), 0);
  return inSeconds ? Math.round(total / 60) : total;
}

function _formatStudyTime(minutes) {
  if (!minutes || minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

async function _loadAdminUsers() {
  const content = document.getElementById("sp-admin-content");
  if (!content) return;
  content.innerHTML = `<div class="sp-empty"><div style="font-size:28px">⏳</div>Chargement…</div>`;
  try {
    // ① Read all known profiles (everyone who logged in after the profile system was added)
    const profileSnap = await getDocs(collection(db, "userProfiles"));
    const profileMap = {}; // uid → profile object
    profileSnap.forEach(d => { profileMap[d.id] = d.data(); });

    // ② Scan the 'data' subcollection across ALL users via collectionGroup
    //    This catches anyone who had data before userProfiles was introduced
    try {
      const dataSnap = await getDocs(collectionGroup(db, "data"));
      dataSnap.forEach(d => {
        const uid = d.ref.parent?.parent?.id;
        if (uid && !profileMap[uid]) {
          profileMap[uid] = { uid, email: uid, displayName: "", photoURL: "" };
        }
      });
    } catch (_) { /* collectionGroup may need an index rule — non-critical */ }

    const uids = Object.keys(profileMap);
    if (uids.length === 0) {
      content.innerHTML = `<div class="sp-empty">Aucun utilisateur enregistré.</div>`;
      return;
    }

    // ③ Load sessions + rewards in parallel for every user
    const usersData = await Promise.all(uids.map(async (uid) => {
      const profile = profileMap[uid];
      let sessions = 0, studyMinutes = 0, rewards = [];
      try {
        const [sessSnap, rewSnap] = await Promise.all([
          getDoc(doc(db, "users", uid, "data", "studypro_sessions")),
          getDocs(collection(db, "users", uid, "rewards")),
        ]);
        if (sessSnap.exists()) {
          try {
            const arr = JSON.parse(sessSnap.data().value || "[]");
            sessions = arr.length;
            studyMinutes = _parseStudyMinutes(arr);
          } catch (_) {}
        }
        rewards = rewSnap.docs.map(d => d.data());
      } catch (_) {}
      return { ...profile, sessions, studyMinutes, rewards };
    }));

    // ④ Sort by study time descending (most active first)
    usersData.sort((a, b) => (b.studyMinutes || 0) - (a.studyMinutes || 0));

    content.innerHTML = `
      <div class="sp-admin-bar">
        <span class="sp-chip">👥 ${usersData.length} utilisateurs</span>
        <button class="sp-refresh-btn" id="sp-refresh-btn">🔄 Rafraîchir</button>
      </div>
      <div class="sp-user-list">
        ${usersData.map(u => _renderUserCard(u)).join("")}
      </div>`;

    document.getElementById("sp-refresh-btn")?.addEventListener("click", _loadAdminUsers);

    // ⑤ Attach medal-send listeners
    usersData.forEach(u => {
      const toggleBtn = document.getElementById(`amd-btn-${u.uid}`);
      const form      = document.getElementById(`amd-form-${u.uid}`);
      toggleBtn?.addEventListener("click", () => {
        form.style.display = form.style.display === "none" ? "flex" : "none";
      });
      form?.querySelectorAll(".amd-option").forEach(opt => {
        opt.addEventListener("click", async () => {
          const medal = ADMIN_MEDALS.find(m => m.id === opt.dataset.mid);
          if (!medal) return;
          opt.disabled = true;
          await _awardMedal(u.uid, {
            id: `${medal.id}_${Date.now()}`, baseId: medal.id,
            emoji: medal.emoji, title: medal.title,
            description: medal.description,
            type: "admin", awardedAt: Date.now(),
            awardedBy: state.user?.email || ADMIN_EMAIL,
          });
          form.style.display = "none";
          opt.disabled = false;
          _showToast(`🏅 Médaille <b>${medal.title}</b> envoyée à ${u.displayName || u.email} !`, "info", 3500);
        });
      });
    });

  } catch (e) {
    console.error("[studypro] Admin panel error:", e);
    const c = document.getElementById("sp-admin-content");
    if (c) c.innerHTML = `<div class="sp-empty">⚠️ Erreur d'accès — vérifiez les règles Firestore.<br><small style="color:#94a3b8">${e.message}</small></div>`;
  }
}

function _renderUserCard(u) {
  const timeStr   = _formatStudyTime(u.studyMinutes || 0);
  const medals    = u.rewards || [];
  const rankEmoji = u.studyMinutes > 0 ? (u.studyMinutes >= 120 ? "🥇" : u.studyMinutes >= 30 ? "🥈" : "🥉") : "";

  const medalsHtml = medals.length > 0
    ? `<div class="sp-user-medals">${medals.map(r =>
        `<span class="sp-medal-pip" title="${r.title}">${r.emoji}</span>`).join("")}</div>`
    : `<div class="sp-user-medals sp-user-medals--empty">Aucune médaille</div>`;

  return `
    <div class="sp-user-card">
      <div class="sp-user-card-row">
        <div class="sp-user-info-col">
          <div class="sp-user-card-name">
            ${rankEmoji ? `<span class="sp-rank">${rankEmoji}</span>` : ""}
            ${u.displayName || "—"}
          </div>
          <div class="sp-user-card-email">${u.email}</div>
          ${medalsHtml}
        </div>
        <div class="sp-user-chips">
          <span class="sp-chip" title="Sessions Pomodoro">⏱️ ${u.sessions} séances</span>
          <span class="sp-chip" title="Temps total d'étude">🕐 ${timeStr}</span>
        </div>
      </div>
      <button class="sp-medal-btn" id="amd-btn-${u.uid}">🏅 Envoyer une médaille</button>
      <div class="sp-medal-form" id="amd-form-${u.uid}" style="display:none">
        ${ADMIN_MEDALS.map(m =>
          `<button class="amd-option" data-mid="${m.id}">${m.emoji} ${m.title}</button>`
        ).join("")}
      </div>
    </div>`;
}

// ─── Data initialisation (abort-safe) ─────────────────────────────────────
// Returns true if aborted (a newer call took over), false on success.
async function _initUserData(uid) {
  const myId = ++_currentInitId;

  // ① Cancel ALL previous listeners immediately — no stale data mixing
  _cancelAllListeners();
  state.cache = {};

  let permErr = false;

  // ② One-time read for non-notes keys (+ totalStudyMinutes accumulator)
  await Promise.all([
    ...DATA_KEYS.map(async (key) => {
      if (myId !== _currentInitId) return;
      try {
        const snap = await getDoc(doc(db, "users", uid, "data", key));
        if (snap.exists() && myId === _currentInitId) {
          state.cache[key] = snap.data().value;
        }
      } catch (e) {
        if (e.code === "permission-denied") permErr = true;
        else console.warn("[studypro] Read error:", key, e);
      }
    }),
    // Load cumulative study-minute counter
    (async () => {
      try {
        const smSnap = await getDoc(doc(db, "users", uid, "data", "studyMinutes"));
        if (smSnap.exists()) {
          state.totalStudyMinutes = smSnap.data().totalMinutes || 0;
        } else {
          // First run: bootstrap from sessions array to preserve existing progress
          state.totalStudyMinutes = 0;
          // Will be initialised after sessions are loaded (done below)
        }
      } catch (_) { state.totalStudyMinutes = 0; }
    })(),
  ]);

  if (myId !== _currentInitId) return true; // aborted

  // Bootstrap totalMinutes from sessions array if Firestore counter doesn't exist yet
  if (state.totalStudyMinutes === 0) {
    try {
      const smSnap = await getDoc(doc(db, "users", uid, "data", "studyMinutes"));
      if (!smSnap.exists()) {
        const arr = JSON.parse(state.cache["studypro_sessions"] || "[]");
        const mins = _parseStudyMinutes(arr);
        if (mins > 0) {
          state.totalStudyMinutes = mins;
          setDoc(doc(db, "users", uid, "data", "studyMinutes"), { totalMinutes: mins })
            .catch(() => {});
        }
      }
    } catch (_) {}
  }

  // Recover from localStorage backup if it has a higher value (protects against sudden tab-close)
  try {
    const bk = parseInt(_oGet.call(localStorage, `sp_sm_bk_${uid}`) || "0", 10);
    if (bk > state.totalStudyMinutes) {
      console.log("[studypro] Restoring study minutes from localStorage backup:", bk);
      state.totalStudyMinutes = bk;
      setDoc(doc(db, "users", uid, "data", "studyMinutes"), { totalMinutes: bk })
        .catch(() => {});
    }
  } catch (_) {}

  // Seed _lastTierName so _checkTierUp() never fires a false tier-up on first tick
  _lastTierName = _getCurrentTier(state.totalStudyMinutes).name;
  _logTierState(); // initial diagnostic log after login

  if (myId !== _currentInitId) return true; // aborted

  // ③ Notes via onSnapshot — wait for first fire, then keep listening
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 4000);
    let resolved = false;

    const unsub = onSnapshot(
      collection(db, "users", uid, "notes"),
      (snap) => {
        if (myId !== _currentInitId) { unsub(); return; } // abort check
        const obj = {};
        snap.forEach((d) => { obj[d.id] = d.data().content; });
        if (Object.keys(obj).length > 0) {
          state.cache["studypro_day_notes"] = JSON.stringify(obj);
        }
        console.log("[studypro] Notes synchronisées en temps réel pour UID:", uid);
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
      },
      (err) => {
        if (err.code === "permission-denied") permErr = true;
        else console.warn("[studypro] Notes snapshot error:", err);
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
      }
    );

    // Register the ongoing listener so it can be cancelled on next switch
    _registerListener(uid, unsub);
  });

  if (myId !== _currentInitId) return true; // aborted after snapshot

  if (permErr) _showPermissionToast();
  return false; // success
}

// ─── React loader (cache-busted per login to force re-initialisation) ──────
let _reactBuildId = 0;

function _loadReactApp(onReady) {
  _reactBuildId++;                            // new URL → browser re-executes module
  const root = document.getElementById("root");
  root.innerHTML = "";                         // unmount previous React tree
  root.style.opacity = "0";

  const s = document.createElement("script");
  s.type = "module";
  s.setAttribute("crossorigin", "");
  s.src = `index-Ci3ALCsl.js?_v=${_reactBuildId}`;
  s.onload = () => {
    setTimeout(() => {
      _hideSkeleton();
      root.style.transition = "opacity 0.35s ease";
      root.style.opacity = "1";
      if (onReady) onReady();
      // Start watching for the Stats tab so we can inject the tier card
      _startStatsObserver();
    }, 80);
  };
  s.onerror = () => {
    _hideSkeleton();
    root.style.opacity = "1";
    _showToast("❌ Erreur de chargement de l'application.", "error");
    console.error("[studypro] Failed to load React bundle.");
  };
  document.head.appendChild(s);
}

// ─── Real-time timer tracking ──────────────────────────────────────────────
// Saves +1 minute to Firestore every 60s while the Pomodoro timer is running.
// Uses Firestore increment() so minutes accumulate additively (never reset).
function _startTimerTracking(uid) {
  if (_timerInterval) clearInterval(_timerInterval);
  _timerInterval = setInterval(async () => {
    if (!state.uid || state.uid !== uid) return;
    try {
      const ts = JSON.parse(state.cache["studypro_timer_state"] || "{}");
      // The compiled app stores isRunning in multiple possible field names
      const isRunning = ts.isRunning === true || ts.running === true ||
                        ts.status === "running" || (ts.phase === "focus" && ts.active === true);
      if (isRunning) {
        await setDoc(
          doc(db, "users", uid, "data", "studyMinutes"),
          { totalMinutes: increment(1) },
          { merge: true }
        );
        state.totalStudyMinutes = (state.totalStudyMinutes || 0) + 1;
        // Backup to localStorage so a sudden tab-close doesn't lose progress
        _oSet.call(localStorage, `sp_sm_bk_${uid}`, String(state.totalStudyMinutes));
        _refreshStatsTier();
        _syncDashboardTotal();
        _checkTierUp();
        _checkAutoMedals(uid);
        _logTierState();
      }
    } catch (e) { console.warn("[studypro] Timer tracking error:", e); }
  }, 60000);

  // Backup totalMinutes to localStorage before tab closes (in case Firestore write is in-flight)
  window.addEventListener("beforeunload", () => {
    if (state.uid === uid && state.totalStudyMinutes > 0) {
      _oSet.call(localStorage, `sp_sm_bk_${uid}`, String(state.totalStudyMinutes));
    }
  });
}

function _stopTimerTracking() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

// ─── Stats section evolution injection ─────────────────────────────────────
// Injects the tier progress card into the React Stats section via MutationObserver.
// Detects the <h2>Tableau de bord</h2> heading that is hard-coded in the compiled bundle.
function _startStatsObserver() {
  if (_statsObserver) { _statsObserver.disconnect(); _statsObserver = null; }
  const root = document.getElementById("root");
  if (!root) return;
  _statsObserver = new MutationObserver(_tryInjectDashboardWidgets);
  _statsObserver.observe(root, { childList: true, subtree: true });
  // Run immediately in case stats is the active tab
  setTimeout(_tryInjectDashboardWidgets, 150);
}

let _widgetRAF = false;
function _tryInjectDashboardWidgets() {
  if (_widgetRAF) return;          // coalesce rapid MutationObserver bursts into one frame
  _widgetRAF = true;
  requestAnimationFrame(() => {
    _widgetRAF = false;
    _tryInjectStatsEvolution();
    _tryInjectInbox();
    _syncDashboardTotal();
    _hideSonsSection();
  });
}

function _tryInjectStatsEvolution() {
  // Walk DOM to find h2 "Tableau de bord" (only rendered when Stats tab is active)
  let statsContainer = null;
  for (const h2 of document.querySelectorAll("h2")) {
    if (h2.textContent.trim() === "Tableau de bord") {
      // Structure: h2 → div.flex.items-center → div.bg-card → div.flex.flex-col.gap-4
      statsContainer = h2.parentElement?.parentElement?.parentElement;
      break;
    }
  }
  const existing = document.getElementById("sp-stats-tier");
  if (!statsContainer) { existing?.remove(); return; }              // not on stats tab
  if (existing && existing.parentElement === statsContainer) return; // already injected
  existing?.remove();

  const el = document.createElement("div");
  el.id = "sp-stats-tier";
  // Match the exact Tailwind card classes used by the Stats section
  el.className = "bg-card rounded-3xl border border-card-border shadow-md p-6";
  el.innerHTML = `
    <div class="flex items-center gap-2 mb-6">
      <span style="font-size:18px;line-height:1">🏆</span>
      <h2 class="text-base font-semibold">Mon Évolution</h2>
    </div>
    <div id="sp-stats-tier-inner">${_renderTierProgressInline()}</div>`;
  statsContainer.insertBefore(el, statsContainer.firstChild);
}

function _refreshStatsTier() {
  // Only update the inner content — do NOT replace the header
  const inner = document.getElementById("sp-stats-tier-inner");
  if (inner) inner.innerHTML = _renderTierProgressInline();
  // Keep the React "Total historique" card in sync too
  _syncDashboardTotal();
}

// ─── Sync "Total historique" card in Tableau de bord ───────────────────────
// The React app computes this from the sessions array, but we track minutes
// more accurately (per-minute accumulator). Override the displayed value with ours.
function _syncDashboardTotal() {
  if (!state.totalStudyMinutes) return;
  const timeStr = _formatStudyTime(state.totalStudyMinutes);
  const root = document.getElementById("root");
  if (!root) return;

  // Walk all text nodes looking for "historique" (subtitle of the Total card)
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = tw.nextNode())) {
    if (node.nodeValue?.trim() !== "historique") continue;

    // Found it — navigate up to the card container
    const subtitleEl = node.parentElement;
    if (!subtitleEl) break;
    const container = subtitleEl.parentElement;
    if (!container) break;

    // Find the sibling element that shows the time value (e.g. "12h 50min")
    for (const child of container.children) {
      if (child === subtitleEl) continue;
      const t = child.textContent.trim();
      // Match patterns: "35min", "1h", "12h 50min", "0min", etc.
      if (/^(\d+h)?(\s*\d+min)?$/.test(t) && t.length > 0) {
        if (child.textContent !== timeStr) {
          child.textContent = timeStr;
        }
        break;
      }
    }
    break;  // only process first "historique" found
  }
}

// ─── Hide "Sons & Concentration" React section ──────────────────────────────
// IMPORTANT: only target headings (h2/h3/h4) whose text STARTS with "Sons"
// to avoid accidentally hiding the Focus/Timer page which also contains
// the word "concentration" in its text nodes.
function _hideSonsSection() {
  const root = document.getElementById("root") || document.body;
  for (const heading of root.querySelectorAll("h2, h3, h4")) {
    const t = heading.textContent.trim();
    // Must start with "Sons" (the music section heading), not just contain it
    if (!/^sons/i.test(t)) continue;
    // Walk up to find the card container
    let el = heading.parentElement;
    for (let i = 0; i < 6 && el && el !== root; i++) {
      const tag = el.tagName?.toLowerCase();
      if ((tag === "div" || tag === "section") &&
          el.offsetHeight > 60 &&
          !el.id?.startsWith("sp-") &&
          el.dataset.spHidden !== "1") {
        el.style.display = "none";
        el.dataset.spHidden = "1";
        return;
      }
      el = el.parentElement;
    }
  }
}

// ─── Dashboard inbox card ───────────────────────────────────────────────────
function _tryInjectInbox() {
  let statsContainer = null;
  for (const h2 of document.querySelectorAll("h2")) {
    if (h2.textContent.trim() === "Tableau de bord") {
      statsContainer = h2.parentElement?.parentElement?.parentElement;
      break;
    }
  }
  const existing = document.getElementById("sp-inbox-card");
  if (!statsContainer) { existing?.remove(); return; }
  // Card already correctly placed — do NOT touch the DOM here (would re-trigger observer)
  if (existing && existing.parentElement === statsContainer) return;
  existing?.remove();

  const el = document.createElement("div");
  el.id = "sp-inbox-card";
  el.className = "bg-card rounded-3xl border border-card-border shadow-md p-6";
  el.innerHTML = _buildInboxHtml();
  statsContainer.appendChild(el); // placed after the evolution card
  _attachInboxHandlers();
}

function _buildInboxHtml() {
  const unreadCount = _userMessages.filter(m => !m.read).length;
  const msgsHtml = _userMessages.length === 0
    ? `<div class="sp-inbox-empty">
        <div style="font-size:36px;margin-bottom:6px">📭</div>
        Aucun message pour l'instant.<br>
        <span style="font-size:12px;color:#94a3b8">
          Les messages de l'administrateur apparaîtront ici.
        </span>
      </div>`
    : _userMessages.map(m => `
      <div class="sp-inbox-msg ${m.read ? 'sp-inbox-msg--read' : 'sp-inbox-msg--unread'}">
        <div class="sp-inbox-msg-header">
          <span class="sp-inbox-dot ${m.read ? 'sp-inbox-dot--read' : ''}"></span>
          <span class="sp-inbox-author">✉️ ${m.author || 'Admin'}</span>
          <span class="sp-inbox-time">${_formatMsgTime(m.timestamp)}</span>
        </div>
        <div class="sp-inbox-msg-text">${m.text}</div>
        <div class="sp-inbox-actions">
          ${!m.read
            ? `<button class="sp-inbox-read-btn" data-mid="${m.id}">✓ Marquer comme lu</button>`
            : `<span class="sp-inbox-read-status">✓ Lu</span>`}
          <button class="sp-inbox-del-btn" data-mid="${m.id}" title="Supprimer ce message">🗑</button>
        </div>
      </div>`).join('');
  return `
    <div class="flex items-center gap-2 mb-4">
      <span style="font-size:18px;line-height:1">✉️</span>
      <h2 class="text-base font-semibold">Boîte de réception</h2>
      ${unreadCount > 0
        ? `<span class="sp-inbox-badge">${unreadCount} non lu${unreadCount > 1 ? 's' : ''}</span>`
        : ''}
    </div>
    <div id="sp-inbox-list" class="sp-inbox-list">${msgsHtml}</div>`;
}

function _refreshInbox() {
  const card = document.getElementById("sp-inbox-card");
  if (!card) return;
  card.innerHTML = _buildInboxHtml();
  _attachInboxHandlers();
  _updateInboxBadge();
}

function _attachInboxHandlers() {
  document.querySelectorAll(".sp-inbox-read-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mid = btn.dataset.mid;
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "users", state.uid, "messages", mid), { read: true });
        const msg = _userMessages.find(m => m.id === mid);
        if (msg) msg.read = true;
        _refreshInbox();
        // Dismiss the private banner if it was showing this message
        const banner = document.getElementById("sp-private-banner");
        if (banner && banner.dataset.mid === mid) {
          banner.classList.remove("sp-msg-banner--show");
          setTimeout(() => banner.remove(), 320);
        }
      } catch (e) {
        console.warn("[studypro] Message read error:", e);
        btn.disabled = false;
      }
    });
  });

  // Delete handlers
  document.querySelectorAll(".sp-inbox-del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const mid = btn.dataset.mid;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, "users", state.uid, "messages", mid));
        _userMessages = _userMessages.filter(m => m.id !== mid);
        _refreshInbox();
      } catch (e) {
        console.warn("[studypro] Message delete error:", e);
        btn.disabled = false;
      }
    });
  });
}

function _updateInboxBadge() {
  const unread = _userMessages.filter(m => !m.read).length;
  const badge = document.getElementById("ud-inbox-badge");
  if (badge) {
    badge.textContent = unread;
    badge.style.display = unread > 0 ? "inline-flex" : "none";
  }
}

function _formatMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ─── Message listeners & banners ───────────────────────────────────────────
function _listenToGlobalMessage(initId) {
  const unsub = onSnapshot(
    doc(db, "siteConfig", "globalMessage"),
    (snap) => {
      if (initId !== _currentInitId) { try { unsub(); } catch (_) {} return; }
      if (snap.exists() && snap.data().active) {
        _showMessageBanner(snap.data().text, true, null, null);
      } else {
        document.getElementById("sp-global-banner")?.remove();
      }
    },
    (e) => console.warn("[studypro] Global message listener error:", e)
  );
  _registerListener("global", unsub);
}

function _listenToPrivateMessages(uid, initId) {
  const unsub = onSnapshot(
    collection(db, "users", uid, "messages"),
    (snap) => {
      if (initId !== _currentInitId) { try { unsub(); } catch (_) {} return; }
      // Store ALL messages (read + unread), newest first
      _userMessages = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      // Show banner only for the first unread message (non-intrusive notification)
      const unread = _userMessages.filter(m => !m.read);
      if (unread.length > 0) {
        _showMessageBanner(unread[0].text, false, unread[0], uid);
      }
      // Refresh inbox card in Stats/Dashboard tab if visible
      _refreshInbox();
      _updateInboxBadge();
    },
    (e) => console.warn("[studypro] Private messages listener error:", e)
  );
  _registerListener(uid + "_msg", unsub);
}

function _showMessageBanner(text, isGlobal, msg, uid) {
  const bannerId = isGlobal ? "sp-global-banner" : "sp-private-banner";
  // Don't recreate same banner that's already showing the same text
  const existing = document.getElementById(bannerId);
  if (existing && existing.dataset.msgText === text) return;
  existing?.remove();

  const banner = document.createElement("div");
  banner.id = bannerId;
  banner.dataset.msgText = text;
  banner.dataset.mid = msg?.id || "";
  banner.className = `sp-msg-banner${isGlobal ? " sp-msg-banner--global" : " sp-msg-banner--private"}`;
  banner.innerHTML = `
    <span class="sp-msg-icon">${isGlobal ? "📣" : "✉️"}</span>
    <span class="sp-msg-text">${text}</span>
    <button class="sp-msg-close" id="${bannerId}-close">×</button>
  `;

  // Insert right after user-bar if present, else top of body
  const userBar = document.getElementById("user-bar");
  if (userBar && userBar.nextSibling) {
    document.body.insertBefore(banner, userBar.nextSibling);
  } else {
    document.body.prepend(banner);
  }
  requestAnimationFrame(() => { requestAnimationFrame(() => banner.classList.add("sp-msg-banner--show")); });

  document.getElementById(`${bannerId}-close`).addEventListener("click", async () => {
    banner.classList.remove("sp-msg-banner--show");
    setTimeout(() => banner.remove(), 320);
    if (!isGlobal && msg && uid) {
      try { await updateDoc(doc(db, "users", uid, "messages", msg.id), { read: true }); }
      catch (e) { console.warn("[studypro] Message read update error:", e); }
    }
  });
}

// ─── Boot the app for a fully-cleared user ─────────────────────────────────
async function _bootApp(user) {
  state.uid  = user.uid;
  state.user = user;

  _unblockMusic();
  _writeUserProfile(user);  // fire-and-forget
  _injectUserBar(user);
  _fadeOutOverlay();
  _showSkeleton();

  const aborted = await _initUserData(user.uid);
  if (aborted) {
    console.log("[studypro] Init aborted for UID:", user.uid, "(newer auth event took over)");
    return;
  }

  _listenToRewards(user.uid, _currentInitId);
  _listenToGlobalMessage(_currentInitId);
  _listenToPrivateMessages(user.uid, _currentInitId);

  await _checkAutoMedals(user.uid);
  _startTimerTracking(user.uid);
  _loadReactApp();
}

// ─── Post-verification gate: verified → needs name? ────────────────────────
async function _continueAfterVerification(user) {
  if (!user.displayName) {
    _showNameOverlay(user);
  } else {
    await _bootApp(user);
  }
}

// ─── Remove ALL auth/verify/name overlays (prevents stacking) ─────────────
function _removeAllOverlays() {
  ["auth-overlay","sp-verify-overlay","sp-name-overlay"]
    .forEach(id => document.getElementById(id)?.remove());
}

// ─── Email-verification waiting screen ────────────────────────────────────
function _showVerificationOverlay(user) {
  _removeAllOverlays(); // clear login card + any stale verify/name overlays

  const cardStyle = [
    "background:#fff","border-radius:24px","padding:44px 32px 36px",
    "max-width:430px","width:90%","text-align:center",
    "font-family:'Inter',sans-serif","box-shadow:0 24px 64px rgba(0,0,0,.18)",
    "transition:all .3s ease"
  ].join(";");

  const el = document.createElement("div");
  el.id = "sp-verify-overlay";
  el.style.cssText = [
    "position:fixed","inset:0",
    "background:linear-gradient(135deg,#1e3a5f 0%,#3b82f6 100%)",
    "display:flex","align-items:center","justify-content:center",
    "z-index:9999","opacity:0","transition:opacity .3s ease"
  ].join(";");

  el.innerHTML = `
    <div id="sp-verify-card" style="${cardStyle}">
      <div style="font-size:52px;margin-bottom:12px;line-height:1">📬</div>
      <h2 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#1e293b">
        Plus qu'une étape !
      </h2>
      <p style="margin:0 0 6px;font-size:14px;color:#475569;line-height:1.6">
        Un email de vérification a été envoyé à<br>
        <strong style="color:#3b82f6">${user.email}</strong>
      </p>
      <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6">
        Cliquez sur le lien dans votre boîte mail.<br>
        La page se mettra à jour <strong>automatiquement</strong>.
      </p>

      <!-- Status bar -->
      <div id="verify-status-bar"
        style="display:flex;align-items:center;justify-content:center;gap:8px;
               margin-bottom:16px;padding:10px 16px;background:#f0f9ff;
               border-radius:10px;font-size:13px;color:#0369a1;">
        <span id="verify-pulse"
          style="display:inline-block;width:8px;height:8px;border-radius:50%;
                 background:#3b82f6;animation:vPulse 1.4s ease-in-out infinite;flex-shrink:0"></span>
        <span id="verify-status-txt">Vérification automatique en cours…</span>
      </div>

      <!-- Manual check -->
      <button id="verify-manual-btn"
        style="width:100%;padding:15px;background:#3b82f6;color:#fff;border:none;
               border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;
               font-family:'Inter',sans-serif;margin-bottom:10px;">
        J'ai cliqué sur le lien →
      </button>

      <!-- Resend -->
      <button id="verify-resend-btn"
        style="width:100%;padding:13px;background:#f1f5f9;color:#3b82f6;border:none;
               border-radius:14px;font-size:14px;font-weight:500;cursor:pointer;
               font-family:'Inter',sans-serif;">
        Renvoyer l'email
      </button>

      <!-- Spam hint -->
      <p style="margin:10px 0 6px;font-size:12px;color:#64748b;line-height:1.5">
        💡 Pensez à vérifier vos <strong>courriers indésirables (Spams)</strong><br>
        si vous ne voyez pas l'email.
      </p>

      <p id="verify-msg" style="margin:8px 0 0;font-size:13px;min-height:18px;"></p>

      <button id="verify-signout-btn"
        style="margin-top:12px;background:none;border:none;color:#94a3b8;
               font-size:12px;cursor:pointer;font-family:'Inter',sans-serif;
               text-decoration:underline;">
        Me connecter avec un autre compte
      </button>
    </div>`;

  document.body.prepend(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.style.opacity = "1"; }); });

  // ── Helpers (re-query each time, card HTML gets replaced) ───────────────
  const card     = () => document.getElementById("sp-verify-card");
  const msgEl    = () => document.getElementById("verify-msg");
  const statusTxt = () => document.getElementById("verify-status-txt");
  const pulseDot  = () => document.getElementById("verify-pulse");

  // ── Name prompt – morphs the card in-place, no second overlay ──────────
  async function showNamePrompt() {
    const c = card();
    if (!c) return;
    c.innerHTML = `
      <div style="font-size:52px;margin-bottom:12px;line-height:1">🎉</div>
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b">
        Presque fini !
      </h2>
      <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6">
        Email vérifié avec succès.<br>
        Comment devons-nous vous appeler ?
      </p>
      <input id="sp-name-input" type="text" placeholder="Votre nom complet"
        style="width:100%;padding:14px 16px;border:2px solid #e2e8f0;border-radius:14px;
               font-size:15px;font-family:'Inter',sans-serif;box-sizing:border-box;
               margin-bottom:16px;outline:none;transition:border-color .2s;color:#1e293b;" />
      <button id="sp-name-btn"
        style="width:100%;padding:15px;background:#3b82f6;color:#fff;border:none;
               border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;
               font-family:'Inter',sans-serif;">
        Commencer →
      </button>
      <p id="sp-name-msg" style="margin:12px 0 0;font-size:13px;min-height:18px;color:#ef4444;"></p>`;

    const nameInput = document.getElementById("sp-name-input");
    const nameMsg   = () => document.getElementById("sp-name-msg");
    nameInput.focus();
    nameInput.addEventListener("focus", () => { nameInput.style.borderColor = "#3b82f6"; });
    nameInput.addEventListener("blur",  () => { nameInput.style.borderColor = "#e2e8f0"; });

    async function submitName() {
      const name = nameInput.value.trim();
      if (!name) { nameMsg().textContent = "Veuillez entrer votre nom complet."; return; }
      const btn = document.getElementById("sp-name-btn");
      btn.textContent = "Enregistrement…"; btn.disabled = true;
      try {
        await updateProfile(auth.currentUser, { displayName: name });
        await setDoc(
          doc(db, "users", user.uid, "data", "profileName"),
          { value: name }, { merge: true }
        );
        el.remove();
        await _bootApp(auth.currentUser);
      } catch (e) {
        nameMsg().textContent = "Erreur : " + e.message;
        btn.textContent = "Commencer →"; btn.disabled = false;
      }
    }
    document.getElementById("sp-name-btn").addEventListener("click", submitName);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
  }

  // ── forceCheck / _doCheck — single shared logic ─────────────────────────
  async function _doCheck(manual = false) {
    if (!auth.currentUser) return false;
    try {
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        // Kill the single global interval
        if (_verifyPollId) { clearInterval(_verifyPollId); _verifyPollId = null; }
        _signupWaiting = false;
        // Flash green, then morph to name prompt in same card
        if (pulseDot()) { pulseDot().style.background = "#10b981"; pulseDot().style.animation = "none"; }
        if (statusTxt()) statusTxt().textContent = "Email vérifié ✓";
        if (msgEl()) { msgEl().style.color = "#10b981"; msgEl().textContent = ""; }
        setTimeout(showNamePrompt, 400);
        return true;
      }
      if (manual && msgEl()) {
        msgEl().style.color = "#ef4444";
        msgEl().textContent = "Email pas encore vérifié — vérifiez vos spams.";
      }
    } catch (e) {
      if (manual && msgEl()) {
        msgEl().style.color = "#ef4444";
        msgEl().textContent = "Erreur : " + e.message;
      }
    }
    return false;
  }

  // ── Kill any previous poll, start a fresh one every 2 s ─────────────────
  if (_verifyPollId) { clearInterval(_verifyPollId); _verifyPollId = null; }
  _verifyPollId = setInterval(() => _doCheck(false), 2000);

  // ── Auto-resend if last email > 5 min ago (or never sent) ───────────────
  const _vfyKey = "sp_vfy_ts_" + (user.email || "");
  const _lastSent = parseInt(localStorage.getItem(_vfyKey) || "0", 10);
  if (Date.now() - _lastSent > 5 * 60 * 1000) {
    sendEmailVerification(auth.currentUser)
      .then(() => { localStorage.setItem(_vfyKey, String(Date.now())); })
      .catch(() => {}); // silently ignore throttle errors
  }

  // ── forceCheck button (manual) ───────────────────────────────────────────
  document.getElementById("verify-manual-btn").addEventListener("click", async () => {
    const btn = document.getElementById("verify-manual-btn");
    if (!btn) return;
    btn.textContent = "Vérification…"; btn.disabled = true;
    const ok = await _doCheck(true);
    if (!ok && btn) { btn.textContent = "J'ai cliqué sur le lien →"; btn.disabled = false; }
  });

  // ── Resend button (manual) ───────────────────────────────────────────────
  document.getElementById("verify-resend-btn").addEventListener("click", async () => {
    const btn = document.getElementById("verify-resend-btn");
    btn.disabled = true;
    try {
      await sendEmailVerification(auth.currentUser);
      localStorage.setItem(_vfyKey, String(Date.now()));
      if (msgEl()) { msgEl().style.color = "#10b981"; msgEl().textContent = "Email renvoyé ! Vérifiez votre boîte mail et vos spams."; }
    } catch (e) {
      if (msgEl()) {
        msgEl().style.color = "#ef4444";
        msgEl().textContent = e.code === "auth/too-many-requests"
          ? "Trop de tentatives — attendez quelques minutes."
          : ("Erreur : " + e.message);
      }
    }
    setTimeout(() => { if (btn) btn.disabled = false; }, 8000);
  });

  // ── Back to login ────────────────────────────────────────────────────────
  document.getElementById("verify-signout-btn").addEventListener("click", async () => {
    if (_verifyPollId) { clearInterval(_verifyPollId); _verifyPollId = null; }
    el.remove();
    await signOut(auth);
  });
}

// ─── "Enter your full name" screen (first login only) ─────────────────────
function _showNameOverlay(user) {
  _removeAllOverlays(); // clear login card + any stale verify/name overlays

  const el = document.createElement("div");
  el.id = "sp-name-overlay";
  el.style.cssText = [
    "position:fixed","inset:0",
    "background:linear-gradient(135deg,#1e3a5f 0%,#3b82f6 100%)",
    "display:flex","align-items:center","justify-content:center",
    "z-index:9999","opacity:0","transition:opacity .3s ease"
  ].join(";");

  el.innerHTML = `
    <div style="background:#fff;border-radius:24px;padding:44px 32px 36px;
                max-width:430px;width:90%;text-align:center;
                font-family:'Inter',sans-serif;box-shadow:0 24px 64px rgba(0,0,0,.18);">
      <div style="font-size:52px;margin-bottom:12px;line-height:1">🎉</div>
      <h2 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b">
        Bienvenue sur StudyPro !
      </h2>
      <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.6">
        Email vérifié avec succès.<br>
        Comment devons-nous vous appeler ?
      </p>
      <input id="name-input" type="text" placeholder="Votre nom complet"
        style="width:100%;padding:14px 16px;border:2px solid #e2e8f0;border-radius:14px;
               font-size:15px;font-family:'Inter',sans-serif;box-sizing:border-box;
               margin-bottom:16px;outline:none;transition:border-color .2s;color:#1e293b;" />
      <button id="name-submit-btn"
        style="width:100%;padding:15px;background:#3b82f6;color:#fff;border:none;
               border-radius:14px;font-size:15px;font-weight:600;cursor:pointer;
               font-family:'Inter',sans-serif;transition:background .2s;">
        Commencer →
      </button>
      <p id="name-msg" style="margin:14px 0 0;font-size:13px;min-height:20px;color:#ef4444;"></p>
    </div>`;

  document.body.prepend(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.style.opacity = "1"; }); });

  const nameInput = document.getElementById("name-input");
  const msgEl = () => document.getElementById("name-msg");

  nameInput.focus();
  nameInput.addEventListener("focus", () => { nameInput.style.borderColor = "#3b82f6"; });
  nameInput.addEventListener("blur",  () => { nameInput.style.borderColor = "#e2e8f0"; });

  async function submitName() {
    const name = nameInput.value.trim();
    if (!name) { msgEl().textContent = "Veuillez entrer votre nom complet."; return; }
    const btn = document.getElementById("name-submit-btn");
    btn.textContent = "Enregistrement…"; btn.disabled = true;
    try {
      await updateProfile(auth.currentUser, { displayName: name });
      // Persist in Firestore as well
      await setDoc(
        doc(db, "users", user.uid, "data", "profileName"),
        { value: name },
        { merge: true }
      );
      el.remove();
      await _bootApp(auth.currentUser);
    } catch (e) {
      msgEl().textContent = "Erreur : " + e.message;
      btn.textContent = "Commencer →"; btn.disabled = false;
    }
  }

  document.getElementById("name-submit-btn").addEventListener("click", submitName);
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submitName(); });
}

// ─── Auth state handler ────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {

  if (!user) {
    // ── SIGNED OUT ──────────────────────────────────────────────────────
    console.log("[studypro] User signed out — cleaning up.");
    _currentInitId++;              // invalidate any in-flight _initUserData
    _cancelAllListeners();         // kill all Firestore listeners immediately
    state.uid   = null;
    state.user  = null;
    state.cache = {};
    _userRewards = [];
    _userMessages = [];
    _userRole      = "";
    _userStatus    = "";
    _signupWaiting = false;
    if (_verifyPollId) { clearInterval(_verifyPollId); _verifyPollId = null; }
    state.totalStudyMinutes = 0;
    _stopTimerTracking();
    if (_statsObserver) { _statsObserver.disconnect(); _statsObserver = null; }
    document.getElementById("sp-global-banner")?.remove();
    document.getElementById("sp-private-banner")?.remove();
    document.getElementById("sp-stats-tier")?.remove();
    document.getElementById("sp-inbox-card")?.remove();

    document.getElementById("user-bar")?.remove();
    _closeAllPanels();
    _hideSkeleton();
    _blockMusic();

    // Remove all intermediate screens (including login card if somehow still present)
    _removeAllOverlays();

    // Fade existing content out, then show overlay
    const root = document.getElementById("root");
    root.style.transition = "opacity 0.2s ease";
    root.style.opacity = "0";
    setTimeout(() => {
      root.innerHTML = "";
      _showOverlay(); // overlay has its own fade-in via CSS animation
      // Show blocked message if user was kicked out
      if (_blockedMessage) {
        const msg = _blockedMessage;
        _blockedMessage = "";
        setTimeout(() => {
          const err = document.getElementById("auth-error");
          if (err) err.textContent = msg;
        }, 350);
      }
    }, 210);
    return;
  }

  // ── SIGNED IN ──────────────────────────────────────────────────────────
  console.log("[studypro] User signed in:", user.uid);

  // Check if user is blocked before doing anything
  try {
    const profileSnap = await getDoc(doc(db, "userProfiles", user.uid));
    if (profileSnap.exists()) {
      const pdata = profileSnap.data();
      _userRole   = pdata.role   || "";
      _userStatus = pdata.status || "";
      if (_userStatus === "blocked") {
        console.log("[studypro] Blocked user attempted login:", user.uid);
        _blockedMessage = "⛔ Votre accès a été bloqué par l'administrateur.";
        await signOut(auth);
        return;
      }
    }
  } catch (e) { console.warn("[studypro] Profile read error:", e); }

  // ── Email/password accounts: require email verification ─────────────
  const isEmailProvider = user.providerData?.[0]?.providerId === "password";
  if (isEmailProvider && !user.emailVerified) {
    console.log("[studypro] Email not verified — showing verification screen.");
    _showVerificationOverlay(user);
    return;
  }

  // ── First-time email users: require display name ─────────────────────
  if (!user.displayName) {
    console.log("[studypro] No display name — showing name screen.");
    _showNameOverlay(user);
    return;
  }

  // ── All checks passed: boot the app ──────────────────────────────────
  await _bootApp(user);
});

// ─── Music blocker ─────────────────────────────────────────────────────────
let _musicObserver = null;

function _blockMusic() {
  if (_musicObserver) return;
  _musicObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.tagName === "IFRAME") {
          const src = n.src || "";
          if (src.includes("youtube") || src.includes("spotify")) {
            n.src = ""; n.style.display = "none";
          }
        }
      }
    }
  });
  _musicObserver.observe(document.body, { childList: true, subtree: true });
}

function _unblockMusic() {
  if (_musicObserver) { _musicObserver.disconnect(); _musicObserver = null; }
}

// ─── Skeleton loader ────────────────────────────────────────────────────────
function _showSkeleton() {
  if (document.getElementById("sp-skeleton")) return;
  const sk = document.createElement("div");
  sk.id = "sp-skeleton";
  sk.innerHTML = `
    <div class="sk-topbar">
      <div class="sk-row">
        <div class="sk-pulse" style="width:36px;height:36px;border-radius:10px"></div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div class="sk-pulse" style="width:90px;height:13px;border-radius:6px"></div>
          <div class="sk-pulse" style="width:60px;height:10px;border-radius:6px"></div>
        </div>
      </div>
      <div class="sk-pulse" style="width:28px;height:28px;border-radius:50%"></div>
    </div>
    <div class="sk-body">
      <div class="sk-col-main">
        <div class="sk-card" style="height:340px">
          <div class="sk-pulse" style="width:100px;height:14px;border-radius:6px;margin:0 auto 20px"></div>
          <div class="sk-pulse" style="width:160px;height:160px;border-radius:50%;margin:0 auto 24px"></div>
          <div class="sk-pulse" style="width:130px;height:42px;border-radius:22px;margin:0 auto 16px"></div>
          <div style="display:flex;gap:12px;justify-content:center">
            <div class="sk-pulse" style="width:80px;height:36px;border-radius:10px"></div>
            <div class="sk-pulse" style="width:80px;height:36px;border-radius:10px"></div>
          </div>
        </div>
        <div class="sk-card" style="height:90px;margin-top:12px">
          <div class="sk-pulse" style="width:70%;height:12px;border-radius:6px;margin-bottom:10px"></div>
          <div class="sk-pulse" style="width:50%;height:12px;border-radius:6px"></div>
        </div>
      </div>
      <div class="sk-col-side">
        <div class="sk-card" style="height:160px">
          <div class="sk-pulse" style="width:80px;height:12px;border-radius:6px;margin-bottom:16px"></div>
          <div style="display:flex;gap:8px">
            <div class="sk-pulse" style="flex:1;height:38px;border-radius:10px"></div>
            <div class="sk-pulse" style="flex:1;height:38px;border-radius:10px"></div>
          </div>
        </div>
        <div class="sk-card" style="height:200px;margin-top:12px">
          <div class="sk-pulse" style="width:60%;height:12px;border-radius:6px;margin-bottom:12px"></div>
          <div class="sk-pulse" style="width:80%;height:10px;border-radius:4px;margin-bottom:8px"></div>
          <div class="sk-pulse" style="width:70%;height:10px;border-radius:4px"></div>
        </div>
      </div>
    </div>
    <div class="sk-bottomnav">
      ${["Focus","Calendrier","Tâches","Stats"].map(() => `
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <div class="sk-pulse" style="width:24px;height:24px;border-radius:6px"></div>
          <div class="sk-pulse" style="width:44px;height:10px;border-radius:4px"></div>
        </div>`).join("")}
    </div>
  `;
  document.body.insertBefore(sk, document.getElementById("root"));
}

function _hideSkeleton() {
  const sk = document.getElementById("sp-skeleton");
  if (!sk) return;
  sk.style.transition = "opacity 0.2s ease";
  sk.style.opacity = "0";
  setTimeout(() => sk.remove(), 220);
}

// ─── Theme helpers ─────────────────────────────────────────────────────────
function _applyTheme() {
  const saved = localStorage.getItem("sp_theme");
  if (saved === "dark") document.documentElement.classList.add("sp-dark");
  else document.documentElement.classList.remove("sp-dark");
}

function _toggleTheme() {
  const isDark = document.documentElement.classList.toggle("sp-dark");
  localStorage.setItem("sp_theme", isDark ? "dark" : "light");
  return isDark;
}

// ─── User bar + Profile dropdown ───────────────────────────────────────────
let _ddCloseHandler = null;

function _injectUserBar(user) {
  // Remove old bar + old outside-click listener
  document.getElementById("user-bar")?.remove();
  if (_ddCloseHandler) {
    document.removeEventListener("click", _ddCloseHandler);
    _ddCloseHandler = null;
  }

  const bar = document.createElement("div");
  bar.id = "user-bar";
  bar.style.animation = "userBarSlideIn 0.25s ease";
  bar.innerHTML = `
    <span class="sp-brand" aria-label="StudyPro Révisions Médicales">
      <span class="sp-brand-icon">🩺</span>
      <span class="sp-brand-full">StudyPro&nbsp;<span class="sp-brand-sub">Révisions Médicales</span></span>
      <span class="sp-brand-short">StudyPro</span>
    </span>

    <button class="ud-trigger" id="ud-trigger" aria-haspopup="true" aria-expanded="false">
      <img class="ud-trigger-avatar" src="${user.photoURL || ""}" alt=""
           onerror="this.style.display='none'" />
      <span class="ud-trigger-name">${user.displayName || user.email}</span>
      <svg class="ud-caret" width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <div class="ud-menu" id="ud-menu" role="menu">
      <div class="ud-header">
        <img class="ud-avatar" src="${user.photoURL || ""}" alt=""
             onerror="this.style.display='none'" />
        <div>
          <div class="ud-name">${user.displayName || "Utilisateur"}</div>
          <div class="ud-email">${user.email || ""}</div>
        </div>
      </div>

      <div class="ud-divider"></div>

      <div class="ud-status">
        <span class="ud-dot"></span>
        Connecté en tant qu'étudiant
      </div>

      <div class="ud-divider"></div>

      <button class="ud-item" id="ud-theme-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="5"/>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42
                   M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        <span id="ud-theme-label"></span>
      </button>

      <div class="ud-divider"></div>

      <button class="ud-item" id="ud-trophees-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M6 4h12v10a6 6 0 01-12 0V4zM8 21h8M12 17v4"/>
        </svg>
        Mes Trophées
        <span id="ud-medal-count" class="ud-badge" style="display:none"></span>
      </button>

      <button class="ud-item" id="ud-inbox-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
        Boîte de réception
        <span id="ud-inbox-badge" class="ud-badge ud-badge--msg" style="display:none"></span>
      </button>

      ${(user.email === ADMIN_EMAIL || _userRole === "admin") ? `
      <button class="ud-item ud-item--admin" id="ud-admin-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/>
        </svg>
        Panneau de Contrôle
      </button>` : ""}

      <div class="ud-divider"></div>

      <button class="ud-item ud-item--danger" id="ud-logout-btn">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
        </svg>
        Se déconnecter
      </button>
    </div>
  `;
  document.body.appendChild(bar);

  // Set initial theme label
  const themeLabel = document.getElementById("ud-theme-label");
  themeLabel.textContent = document.documentElement.classList.contains("sp-dark")
    ? "Mode Clair" : "Mode Sombre";

  // Toggle dropdown open/close
  const trigger = document.getElementById("ud-trigger");
  const menu    = document.getElementById("ud-menu");

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.toggle("ud-open");
    trigger.setAttribute("aria-expanded", isOpen);
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") _closeDropdown();
  });

  // Theme toggle
  document.getElementById("ud-theme-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const isDark = _toggleTheme();
    themeLabel.textContent = isDark ? "Mode Clair" : "Mode Sombre";
  });

  // Trophées panel
  document.getElementById("ud-trophees-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    _showRewardsPanel();
  });

  // Inbox — navigate to Stats/Dashboard tab where the inbox card lives
  document.getElementById("ud-inbox-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    _closeDropdown();
    // Find and click the Stats/Tableau de bord nav item in the React app
    const navBtns = document.querySelectorAll("button, a");
    for (const btn of navBtns) {
      const t = btn.textContent?.trim();
      if (t === "Stats" || t === "Statistiques" || t === "Tableau de bord") {
        btn.click();
        break;
      }
    }
  });

  // Admin panel (only rendered for admin email)
  document.getElementById("ud-admin-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _showAdminPanel();
  });

  // Logout
  document.getElementById("ud-logout-btn").addEventListener("click", async () => {
    document.getElementById("ud-logout-btn").disabled = true;
    _closeDropdown();
    await signOut(auth); // onAuthStateChanged(null) takes over
  });

  // Outside click closes the menu
  _ddCloseHandler = (e) => {
    if (!bar.contains(e.target)) _closeDropdown();
  };
  document.addEventListener("click", _ddCloseHandler);
}

function _closeDropdown() {
  const menu = document.getElementById("ud-menu");
  const trigger = document.getElementById("ud-trigger");
  menu?.classList.remove("ud-open");
  trigger?.setAttribute("aria-expanded", "false");
}

// ─── Login overlay ─────────────────────────────────────────────────────────
function _fadeOutOverlay() {
  const el = document.getElementById("auth-overlay");
  if (!el) return;
  el.style.transition = "opacity 0.25s ease";
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 260);
}

// Maps Firebase Auth error codes to friendly French messages
function _authError(code) {
  const map = {
    "auth/user-not-found":        "Aucun compte trouvé avec cet email.",
    "auth/wrong-password":        "Mot de passe incorrect.",
    "auth/invalid-credential":    "Email ou mot de passe incorrect.",
    "auth/invalid-email":         "Adresse email invalide.",
    "auth/email-already-in-use":  "Un compte existe déjà avec cet email.",
    "auth/weak-password":         "Mot de passe trop court (minimum 6 caractères).",
    "auth/too-many-requests":     "Trop de tentatives. Réessayez dans quelques minutes.",
    "auth/network-request-failed":"Erreur réseau. Vérifiez votre connexion.",
    "auth/popup-closed-by-user":  "Fenêtre Google fermée. Réessayez.",
    "auth/cancelled-popup-request":"",
  };
  return map[code] || "Une erreur est survenue. Veuillez réessayer.";
}

const _googleIconSVG = `<svg width="20" height="20" viewBox="0 0 48 48">
  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.7 0 6.7 5.4 2.7 13.3l7.8 6.1C12.4 13.4 17.8 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.5 37.5 46.5 31.4 46.5 24.5z"/>
  <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6L2.5 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.5 10.6l8-6z"/>
  <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.5 2.2-6.2 0-11.5-4-13.5-9.3l-8 6.1C6.6 42.5 14.7 48 24 48z"/>
</svg>`;

function _showOverlay() {
  if (document.getElementById("auth-overlay")) return;
  const el = document.createElement("div");
  el.id = "auth-overlay";
  el.innerHTML = `
    <div class="auth-card">
      <div class="auth-logo">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <rect width="48" height="48" rx="12" fill="#3B82F6"/>
          <path d="M14 34V20l10-8 10 8v14H28v-8h-8v8H14z" fill="white"/>
        </svg>
      </div>
      <h1 class="auth-title">StudyPro</h1>
      <p class="auth-subtitle">Connectez-vous pour accéder à votre tableau de bord</p>

      <!-- Google -->
      <button id="google-signin-btn">
        ${_googleIconSVG}
        Continuer avec Google
      </button>

      <!-- Divider -->
      <div class="auth-divider">OU</div>

      <!-- Email form -->
      <form id="auth-email-form" autocomplete="on" onsubmit="return false">
        <input class="auth-input" id="auth-email" type="email"
               placeholder="Adresse email" autocomplete="email" />
        <input class="auth-input" id="auth-password" type="password"
               placeholder="Mot de passe" autocomplete="current-password" />

        <button class="auth-btn-primary" id="auth-signin-btn" type="button">Se connecter</button>
        <button class="auth-btn-outline" id="auth-signup-btn" type="button">S'inscrire</button>

        <button class="auth-forgot" id="auth-forgot-btn" type="button">Mot de passe oublié ?</button>
      </form>

      <p id="auth-error"  class="auth-error"></p>
      <p id="auth-success" class="auth-success"></p>
    </div>
  `;
  document.body.prepend(el);

  const errEl  = () => document.getElementById("auth-error");
  const succEl = () => document.getElementById("auth-success");
  const emailEl    = () => document.getElementById("auth-email");
  const passwordEl = () => document.getElementById("auth-password");

  function _setFormBusy(busy) {
    ["google-signin-btn","auth-signin-btn","auth-signup-btn","auth-forgot-btn"]
      .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = busy; });
  }
  function _clearMessages() {
    errEl().textContent  = "";
    succEl().textContent = "";
  }

  // ── Google sign-in ────────────────────────────────────────────────
  document.getElementById("google-signin-btn").addEventListener("click", async () => {
    _clearMessages();
    _setFormBusy(true);
    document.getElementById("google-signin-btn").innerHTML =
      `${_googleIconSVG} Connexion en cours…`;
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      const msg = _authError(e.code);
      if (msg) errEl().textContent = msg;
      document.getElementById("google-signin-btn").innerHTML =
        `${_googleIconSVG} Continuer avec Google`;
      _setFormBusy(false);
    }
  });

  // ── Email sign-in ─────────────────────────────────────────────────
  document.getElementById("auth-signin-btn").addEventListener("click", async () => {
    _clearMessages();
    const email    = emailEl().value.trim();
    const password = passwordEl().value;
    if (!email || !password) {
      errEl().textContent = "Veuillez remplir l'email et le mot de passe.";
      return;
    }
    _setFormBusy(true);
    document.getElementById("auth-signin-btn").textContent = "Connexion…";
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
      errEl().textContent = _authError(e.code);
      document.getElementById("auth-signin-btn").textContent = "Se connecter";
      _setFormBusy(false);
    }
  });

  // ── Email sign-up ─────────────────────────────────────────────────
  // ── manualCheckVerification: called when user re-clicks the waiting button ──
  async function manualCheckVerification() {
    if (!auth.currentUser) return;
    const sb = document.getElementById("auth-signup-btn");
    try {
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        // Already verified — clear all overlays and continue
        _signupWaiting = false;
        _removeAllOverlays();
        await _continueAfterVerification(auth.currentUser);
      } else {
        // Brief "not yet" feedback on the button
        if (sb) {
          sb.innerHTML = `<span style="font-size:12px">⏳ Pas encore validé — vérifiez vos emails !</span>`;
          setTimeout(() => {
            if (sb && _signupWaiting) {
              sb.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;justify-content:center">
                <span style="display:inline-block;width:7px;height:7px;border-radius:50%;
                             background:#fff;animation:vPulse 1.2s ease-in-out infinite;flex-shrink:0"></span>
                📧 En attente de vérification… Vérifiez vos spams
              </span>`;
            }
          }, 2500);
        }
      }
    } catch (e) {
      if (sb) sb.innerHTML = `<span style="font-size:12px">❌ Erreur — réessayez.</span>`;
    }
  }

  document.getElementById("auth-signup-btn").addEventListener("click", async () => {
    // ── Guard: if account already created, this is a manual verification check ──
    if (_signupWaiting) {
      await manualCheckVerification();
      return;
    }

    _clearMessages();
    const email    = emailEl().value.trim();
    const password = passwordEl().value;
    if (!email || !password) {
      errEl().textContent = "Veuillez remplir l'email et le mot de passe.";
      return;
    }
    _setFormBusy(true);
    document.getElementById("auth-signup-btn").textContent = "Création du compte…";
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // Send verification email — onAuthStateChanged will show the verify overlay
      await sendEmailVerification(cred.user);
      // Set guard flag BEFORE re-enabling button — ensures next click = check, not new signup
      _signupWaiting = true;
      // Animate button into a clickable waiting state
      const sb = document.getElementById("auth-signup-btn");
      if (sb) {
        sb.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;justify-content:center">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;
                       background:#fff;animation:vPulse 1.2s ease-in-out infinite;flex-shrink:0"></span>
          📧 En attente de vérification… Vérifiez vos spams
        </span>`;
        sb.style.fontSize = "13px";
        sb.disabled = false; // re-enable so the guard branch can catch it
      }
    } catch (e) {
      // ── Special case: account exists but not yet verified ─────────────
      // Instead of showing an error, silently sign them in and let
      // onAuthStateChanged route them to the verification screen.
      if (e.code === "auth/email-already-in-use") {
        const email2 = emailEl()?.value.trim();
        const pass2  = passwordEl()?.value;
        if (email2 && pass2) {
          try {
            await signInWithEmailAndPassword(auth, email2, pass2);
            // onAuthStateChanged will handle routing (verify screen or dashboard)
            return;
          } catch (_) { /* wrong password – fall through to show error */ }
        }
        errEl().textContent = "Un compte existe déjà avec cet email. Essayez de vous connecter ou de réinitialiser le mot de passe.";
      } else {
        errEl().textContent = _authError(e.code);
      }
      _signupWaiting = false;
      document.getElementById("auth-signup-btn").textContent = "S'inscrire";
      _setFormBusy(false);
    }
  });

  // ── Password reset ────────────────────────────────────────────────
  document.getElementById("auth-forgot-btn").addEventListener("click", async () => {
    _clearMessages();
    const email = emailEl().value.trim();
    if (!email) {
      errEl().textContent = "Entrez votre email au-dessus pour réinitialiser le mot de passe.";
      return;
    }
    _setFormBusy(true);
    try {
      await sendPasswordResetEmail(auth, email);
      succEl().textContent = "Email de réinitialisation envoyé ! Vérifiez votre boîte mail.";
    } catch (e) {
      errEl().textContent = _authError(e.code);
    }
    _setFormBusy(false);
  });

  // Allow pressing Enter in the password field to sign in
  document.getElementById("auth-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("auth-signin-btn").click();
  });
}

// ─── Toasts ────────────────────────────────────────────────────────────────
let _permToastShown = false;

function _showPermissionToast() {
  if (_permToastShown) return;
  _permToastShown = true;
  _showToast(
    '⚠️ Règles Firestore incomplètes — ' +
    '<a href="https://console.firebase.google.com" target="_blank">corriger →</a>',
    "warn", 0
  );
}

function _showToast(html, type = "info", duration = 5000) {
  const t = document.createElement("div");
  t.className = `sp-toast sp-toast--${type}`;
  t.innerHTML = `<span>${html}</span><button onclick="this.parentElement.remove()">×</button>`;
  document.body.appendChild(t);
  if (duration > 0) setTimeout(() => t.remove(), duration);
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────
_applyTheme();   // restore saved light/dark preference immediately
_blockMusic();
_showOverlay();

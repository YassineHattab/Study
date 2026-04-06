import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  browserLocalPersistence,
  setPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  collectionGroup,
  onSnapshot,
  deleteDoc,
  getDocs,
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
  uid:   null,
  user:  null,
  cache: {},
};

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
];

const ADMIN_MEDALS = [
  { id: "admin_major_promo",      emoji: "🏆", title: "Major de Promo",         description: "Le meilleur de la promotion !" },
  { id: "admin_expert_anatomie",  emoji: "🩺", title: "Expert Anatomie",         description: "Maîtrise parfaite de l'anatomie !" },
  { id: "admin_assiduite",        emoji: "⭐", title: "Assiduité Exemplaire",    description: "Présent et motivé chaque jour !" },
  { id: "admin_courage",          emoji: "💪", title: "Courage",                 description: "Ne lâche jamais !" },
  { id: "admin_meilleur_etudiant",emoji: "🎓", title: "Meilleur Étudiant",       description: "Félicitations pour tes résultats !" },
];

// Live copy of current user's medals (filled by onSnapshot)
let _userRewards = [];

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
      // Notify only when new medal arrives after initial load
      if (_userRewards.length > prev && prev >= 0 && document.getElementById("root").style.opacity === "1") {
        _showMedalNotification(_userRewards[_userRewards.length - 1]);
      }
      _refreshRewardsPanel();
    },
    (e) => console.warn("[studypro] Rewards listener error:", e)
  );
  _registerListener(uid, unsub);
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
    await setDoc(doc(db, "users", uid, "rewards", medal.id), medal);
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

function _renderRewards() {
  if (_userRewards.length === 0) {
    return `<div class="sp-empty">
      <div style="font-size:52px;margin-bottom:10px">🌟</div>
      <div>Aucun trophée pour l'instant.</div>
      <div style="font-size:12px;margin-top:6px;color:#94a3b8">Continue à étudier pour en gagner !</div>
    </div>`;
  }
  return `<div class="sp-rewards-grid">
    ${_userRewards.map(r => `
      <div class="sp-reward-card">
        <div class="sp-reward-emoji">${r.emoji}</div>
        <div class="sp-reward-title">${r.title}</div>
        <div class="sp-reward-desc">${r.description}</div>
        ${r.type === "admin" ? `<div class="sp-reward-badge">Admin</div>` : ""}
      </div>`).join("")}
  </div>`;
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
      <div id="sp-admin-content">
        <div class="sp-empty"><div style="font-size:28px">⏳</div>Chargement des utilisateurs…</div>
      </div>
    </div>
  `;
  el.addEventListener("click", (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  el.querySelector("#sp-panel-close").addEventListener("click", () => el.remove());
  requestAnimationFrame(() => el.classList.add("sp-panel--open"));
  await _loadAdminUsers();
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

  // ② One-time read for non-notes keys
  await Promise.all(DATA_KEYS.map(async (key) => {
    if (myId !== _currentInitId) return;           // abort check
    try {
      const snap = await getDoc(doc(db, "users", uid, "data", key));
      if (snap.exists() && myId === _currentInitId) {
        state.cache[key] = snap.data().value;
      }
    } catch (e) {
      if (e.code === "permission-denied") permErr = true;
      else console.warn("[studypro] Read error:", key, e);
    }
  }));

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

    document.getElementById("user-bar")?.remove();
    _closeAllPanels();
    _hideSkeleton();
    _blockMusic();

    // Fade existing content out, then show overlay
    const root = document.getElementById("root");
    root.style.transition = "opacity 0.2s ease";
    root.style.opacity = "0";
    setTimeout(() => {
      root.innerHTML = "";
      _showOverlay(); // overlay has its own fade-in via CSS animation
    }, 210);
    return;
  }

  // ── SIGNED IN ──────────────────────────────────────────────────────────
  console.log("[studypro] User signed in:", user.uid);
  state.uid  = user.uid;
  state.user = user;

  _unblockMusic();

  // Write/update user profile so admin panel can see this user
  _writeUserProfile(user); // fire-and-forget

  // Immediately update / inject user bar with new account info
  _injectUserBar(user);

  // Remove login overlay with a smooth fade
  _fadeOutOverlay();

  // Show skeleton while loading Firestore data
  _showSkeleton();

  // Capture initId for abort-safe listeners
  const myInitId = _currentInitId + 1; // will be set inside _initUserData

  // Load all data for this UID (abort-safe)
  const aborted = await _initUserData(user.uid);
  if (aborted) {
    console.log("[studypro] Init aborted for UID:", user.uid, "(newer auth event took over)");
    return;
  }

  // Start real-time rewards listener (uses current _currentInitId after _initUserData ran)
  _listenToRewards(user.uid, _currentInitId);

  // Check and award automatic medals based on loaded data
  await _checkAutoMedals(user.uid);

  // All data in cache — load React (or reload it for account switch)
  _loadReactApp();
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

      ${user.email === ADMIN_EMAIL ? `
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
      <button id="google-signin-btn">
        <svg width="20" height="20" viewBox="0 0 48 48">
          <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.7 0 6.7 5.4 2.7 13.3l7.8 6.1C12.4 13.4 17.8 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.5 37.5 46.5 31.4 46.5 24.5z"/>
          <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6L2.5 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.5 10.6l8-6z"/>
          <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.5 2.2-6.2 0-11.5-4-13.5-9.3l-8 6.1C6.6 42.5 14.7 48 24 48z"/>
        </svg>
        Continuer avec Google
      </button>
      <p id="auth-error" class="auth-error"></p>
    </div>
  `;
  document.body.prepend(el);

  document.getElementById("google-signin-btn").addEventListener("click", async () => {
    const btn = document.getElementById("google-signin-btn");
    const errEl = document.getElementById("auth-error");
    btn.disabled = true;
    btn.textContent = "Connexion en cours…";
    errEl.textContent = "";
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // onAuthStateChanged takes over
    } catch (e) {
      console.error("[studypro] signInWithPopup:", e);
      errEl.textContent = "Erreur de connexion. Veuillez réessayer.";
      btn.disabled = false;
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.7 0 6.7 5.4 2.7 13.3l7.8 6.1C12.4 13.4 17.8 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.5 37.5 46.5 31.4 46.5 24.5z"/>
        <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.1.8-4.6L2.5 13.3A23.9 23.9 0 0 0 0 24c0 3.8.9 7.4 2.5 10.6l8-6z"/>
        <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.5 2.2-6.2 0-11.5-4-13.5-9.3l-8 6.1C6.6 42.5 14.7 48 24 48z"/>
      </svg> Continuer avec Google`;
    }
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

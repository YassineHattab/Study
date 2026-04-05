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

    document.getElementById("user-bar")?.remove();
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

  // Immediately update / inject user bar with new account info
  _injectUserBar(user);

  // Remove login overlay with a smooth fade
  _fadeOutOverlay();

  // Show skeleton while loading Firestore data
  _showSkeleton();

  // Load all data for this UID (abort-safe)
  const aborted = await _initUserData(user.uid);
  if (aborted) {
    console.log("[studypro] Init aborted for UID:", user.uid, "(newer auth event took over)");
    return;
  }

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

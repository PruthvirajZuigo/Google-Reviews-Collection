// auth.js — shared login/session handling for the ReviewFlow web UIs.
// Exposes window.ReviewAuth with token helpers, an authenticated fetch,
// login/logout, a login overlay, and a topbar role badge + logout button.
(function () {
  const TOKEN_KEY = "rf_token";
  const ME_KEY = "rf_me";
  const loginCallbacks = [];

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); }
  function getMe() { try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch (e) { return null; } }
  function setMe(me) { localStorage.setItem(ME_KEY, JSON.stringify(me)); }

  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: "Bearer " + t } : {};
  }

  async function apiFetch(url, options) {
    const headers = Object.assign({}, (options && options.headers) || {}, authHeaders());
    return fetch(url, Object.assign({}, options, { headers }));
  }

  async function login(username, password) {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password }),
    });
    if (!res.ok) {
      let msg = "Login failed";
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    const data = await res.json();
    setToken(data.token);
    setMe(data.user);
    return data;
  }

  function logout() {
    clearToken();
    window.location.reload();
  }

  function isAdmin() {
    const m = getMe();
    return !!m && m.role === "admin";
  }

  async function checkAuth() {
    const t = getToken();
    if (!t) return null;
    try {
      const res = await apiFetch("/api/me");
      if (res.ok) {
        const data = await res.json();
        setMe(Object.assign({}, getMe() || {}, data.user, { client: data.client }));
        return data.user;
      }
    } catch (e) {}
    clearToken();
    return null;
  }

  function showLogin(onSuccess) {
    if (document.getElementById("loginOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "loginOverlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-box login-box">' +
      "<h3>Sign in to Zuigo</h3>" +
      '<p class="login-hint">Use the username &amp; password given to you. Admins manage all clients; client accounts only see their own business.</p>' +
      '<div class="login-form">' +
      '<input id="loginUsername" placeholder="Username" autocomplete="username" />' +
      '<input id="loginPassword" type="password" placeholder="Password" autocomplete="current-password" />' +
      '<div id="loginError" class="login-error hidden"></div>' +
      '<button id="loginBtn" class="btn btn-primary">Sign in</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    const errEl = overlay.querySelector("#loginError");
    const btn = overlay.querySelector("#loginBtn");

    const submit = async () => {
      const username = overlay.querySelector("#loginUsername").value.trim();
      const password = overlay.querySelector("#loginPassword").value;
      if (!username || !password) {
        errEl.textContent = "Enter username and password";
        errEl.classList.remove("hidden");
        return;
      }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Signing in…';
      try {
        const data = await login(username, password);
        errEl.classList.add("hidden");
        overlay.remove();
        loginCallbacks.slice().forEach(function (cb) { try { cb(data.user); } catch (e) {} });
        if (onSuccess) onSuccess(data.user);
      } catch (e) {
        errEl.textContent = e.message;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    };
    btn.addEventListener("click", submit);
    overlay.querySelector("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    overlay.querySelector("#loginUsername").addEventListener("keydown", (e) => { if (e.key === "Enter") overlay.querySelector("#loginPassword").focus(); });
    overlay.querySelector("#loginUsername").focus();
  }

  function renderAuthUI() {
    const me = getMe();
    if (!me) return;
    const nav = document.querySelector(".topnav");
    if (!nav || nav.querySelector(".auth-ui")) return;
    const isAdminUser = me.role === "admin";
    const label = isAdminUser
      ? "👑 Admin — all clients"
      : "🏪 Client — " + (me.client && me.client.name ? me.client.name : (me.clientId || "your business"));
    const wrap = document.createElement("span");
    wrap.className = "auth-ui";
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:8px;margin-left:8px";
    wrap.innerHTML =
      '<span class="badge ' + (isAdminUser ? "badge-admin" : "badge-client") + '" title="Your login role">' + label + "</span>" +
      '<button id="logoutBtn" class="btn btn-secondary" style="padding:4px 10px;font-size:.75rem">Log out</button>';
    nav.appendChild(wrap);
    nav.querySelector("#logoutBtn").addEventListener("click", function () { logout(); });
  }

  function onLogin(cb) {
    loginCallbacks.push(cb);
  }

  window.ReviewAuth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    getMe: getMe,
    setMe: setMe,
    authHeaders: authHeaders,
    apiFetch: apiFetch,
    login: login,
    logout: logout,
    isAdmin: isAdmin,
    checkAuth: checkAuth,
    showLogin: showLogin,
    renderAuthUI: renderAuthUI,
    onLogin: onLogin,
  };
})();

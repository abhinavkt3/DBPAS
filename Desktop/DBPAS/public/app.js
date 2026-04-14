const root = document.getElementById("app");
const TOKEN_KEY = "dbpas_session_token";
const initialParams = new URLSearchParams(window.location.search);

const state = {
  publicBootstrap: null,
  dashboard: null,
  detailsByProductId: {},
  selectedProductId: initialParams.get("pid"),
  activeView: null,
  verifyTokenOverride: initialParams.get("t") || "",
  lastAudit: null,
  lastVerification: null,
  sessionToken: localStorage.getItem(TOKEN_KEY) || "",
  toast: null,
  loading: false
};

initialize();

async function initialize() {
  state.publicBootstrap = await api("/api/bootstrap", { public: true });

  if (state.sessionToken) {
    try {
      await refreshDashboard(state.selectedProductId);
    } catch {
      clearSession();
    }
  }

  bindGlobalEvents();
  render();
}

function bindGlobalEvents() {
  root.addEventListener("click", handleClick);
  root.addEventListener("submit", handleSubmit);
  root.addEventListener("change", handleChange);
}

async function handleClick(event) {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    state.activeView = viewButton.dataset.view;
    syncUrl();
    render();
    return;
  }

  const productButton = event.target.closest("[data-product-id]");
  if (productButton) {
    state.selectedProductId = productButton.dataset.productId;
    state.lastAudit = null;
    state.lastVerification = null;
    await perform(async () => {
      await loadProductDetails(state.selectedProductId);
    });
    syncUrl();
    render();
    return;
  }

  const logoutButton = event.target.closest("[data-logout]");
  if (logoutButton) {
    await perform(async () => {
      if (state.sessionToken) {
        await api("/api/auth/logout", { method: "POST" });
      }
      clearSession();
      state.publicBootstrap = await api("/api/bootstrap", { public: true });
      toast("Signed out.");
    });
    return;
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    await navigator.clipboard.writeText(copyButton.dataset.copy);
    toast("Copied to clipboard.");
    return;
  }

  const geolocateButton = event.target.closest("[data-geolocate-prefix]");
  if (geolocateButton) {
    await autofillCurrentLocation(geolocateButton.dataset.geolocatePrefix, geolocateButton);
    return;
  }

  const auditButton = event.target.closest("[data-run-audit]");
  if (auditButton) {
    await runAudit();
    return;
  }

  const statusButton = event.target.closest("[data-account-id][data-next-status]");
  if (statusButton) {
    await perform(async () => {
      await api(`/api/accounts/${encodeURIComponent(statusButton.dataset.accountId)}/status`, {
        method: "POST",
        body: {
          status: statusButton.dataset.nextStatus
        }
      });
      await refreshDashboard(state.selectedProductId);
      toast(`Account status updated to ${statusButton.dataset.nextStatus}.`);
    });
  }
}

function handleChange(event) {
  const roleSelect = event.target.closest("[data-role-select]");
  if (roleSelect) {
    syncCreateAccountForm(roleSelect);
    return;
  }

  const accountSelect = event.target.closest("[data-gps-target-prefix]");
  if (accountSelect) {
    syncGpsFieldsFromAccountSelection(accountSelect);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);

  if (form.id === "login-form") {
    await perform(async () => {
      const result = await api("/api/auth/login", {
        method: "POST",
        public: true,
        body: {
          username: formData.get("username"),
          password: formData.get("password")
        }
      });

      state.sessionToken = result.token;
      localStorage.setItem(TOKEN_KEY, result.token);
      await refreshDashboard(state.selectedProductId);
      toast("Signed in successfully.");
    });
    return;
  }

  if (form.id === "create-account-form") {
    await perform(async () => {
      await api("/api/accounts", {
        method: "POST",
        body: {
          displayName: formData.get("displayName"),
          username: formData.get("username"),
          password: formData.get("password"),
          email: formData.get("email"),
          role: formData.get("role"),
          postSaleOrdinal: formData.get("postSaleOrdinal"),
          registeredGps: readGps(formData, "account")
        }
      });
      form.reset();
      syncCreateAccountForm(form.querySelector("[data-role-select]"));
      await refreshDashboard(state.selectedProductId);
      toast("Stakeholder account created.");
    });
    return;
  }

  if (form.id === "register-product-form") {
    await perform(async () => {
      const currentUser = state.dashboard.currentUser;
      const result = await api("/api/products", {
        method: "POST",
        body: {
          productId: formData.get("productId"),
          productName: formData.get("productName"),
          batchNumber: formData.get("batchNumber"),
          manufacturingDate: formData.get("manufacturingDate"),
          description: formData.get("description"),
          category: formData.get("category"),
          destinationAccountId: formData.get("destinationAccountId"),
          gpsFactory: readGps(formData, "factory", currentUser.registeredGps),
          destinationGps: readGps(
            formData,
            "registerDestination",
            getKnownAccount(formData.get("destinationAccountId"))?.registeredGps ?? currentUser.registeredGps
          )
        }
      });
      state.selectedProductId = result.product.id;
      form.reset();
      await refreshDashboard(result.product.id);
      toast("Product registered and scannable QR code generated.");
    });
    return;
  }

  if (form.id === "handoff-form") {
    await perform(async () => {
      const selected = getSelectedProduct();
      await api(`/api/products/${encodeURIComponent(selected.id)}/handoff`, {
        method: "POST",
        body: {
          receiverAccountId: formData.get("receiverAccountId"),
          destinationAccountId: formData.get("destinationAccountId"),
          gpsNow: readGps(formData, "handoff", state.dashboard.currentUser.registeredGps),
          destinationGps: readGps(
            formData,
            "handoffDestination",
            getKnownAccount(formData.get("destinationAccountId"))?.registeredGps ??
              state.dashboard.currentUser.registeredGps
          )
        }
      });
      await refreshDashboard(selected.id);
      toast("Supply-chain handoff committed.");
    });
    return;
  }

  if (form.id === "transfer-form") {
    await perform(async () => {
      const selected = getSelectedProduct();
      await api(`/api/products/${encodeURIComponent(selected.id)}/transfer`, {
        method: "POST",
        body: {
          receiverAccountId: formData.get("receiverAccountId"),
          gpsNow: readGps(formData, "transfer", state.dashboard.currentUser.registeredGps),
          destinationGps: readGps(
            formData,
            "transferDestination",
            getKnownAccount(formData.get("receiverAccountId"))?.registeredGps ??
              state.dashboard.currentUser.registeredGps
          )
        }
      });
      await refreshDashboard(selected.id);
      toast("Atomic checkpoint committed.");
    });
    return;
  }

  if (form.id === "verify-form") {
    await perform(async () => {
      const selected = getSelectedProduct();
      const result = await api(`/api/products/${encodeURIComponent(selected.id)}/verify`, {
        method: "POST",
        body: {
          token: formData.get("token"),
          scanLocation: readGps(formData, "verify", state.dashboard.currentUser.registeredGps)
        }
      });
      state.lastVerification = result.report;
      state.verifyTokenOverride = formData.get("token");
      await refreshDashboard(selected.id);
      toast(`Verification finished with status ${result.report.status}.`);
    });
  }
}

async function refreshDashboard(preferredProductId) {
  state.dashboard = await api("/api/dashboard");
  const views = getViewsForRole(state.dashboard.currentUser.role);
  if (!state.activeView || !views.some((view) => view.key === state.activeView)) {
    state.activeView = getDefaultViewForRole(state.dashboard.currentUser.role);
  }

  const products = state.dashboard.products;
  if (!products.length) {
    state.selectedProductId = null;
    state.detailsByProductId = {};
    state.lastAudit = null;
    state.lastVerification = null;
    render();
    return;
  }

  let targetProductId = preferredProductId || state.selectedProductId;
  if (!targetProductId || !products.some((product) => product.id === targetProductId)) {
    targetProductId = products[0].id;
  }

  state.selectedProductId = targetProductId;
  if (!state.verifyTokenOverride) {
    const selected = products.find((product) => product.id === targetProductId);
    state.verifyTokenOverride = selected?.token || "";
  }

  await loadProductDetails(targetProductId);
  syncUrl();
  render();
}

async function loadProductDetails(productId) {
  if (!productId || !state.sessionToken) {
    return;
  }

  state.detailsByProductId[productId] = await api(`/api/products/${encodeURIComponent(productId)}`);
}

function getSelectedProduct() {
  return state.dashboard?.products.find((product) => product.id === state.selectedProductId) ?? null;
}

function getSelectedDetails() {
  return state.detailsByProductId[state.selectedProductId] ?? null;
}

function getViewsForRole(role) {
  const catalog = {
    admin: [
      { key: "overview", label: "Overview" },
      { key: "accounts", label: "Accounts" },
      { key: "products", label: "Products" }
    ],
    manufacturer: [
      { key: "overview", label: "Overview" },
      { key: "register", label: "Register Product" },
      { key: "products", label: "My Products" },
      { key: "stakeholders", label: "Stakeholders" }
    ],
    distributor: [
      { key: "overview", label: "Overview" },
      { key: "logistics", label: "Logistics" },
      { key: "stakeholders", label: "Stakeholders" }
    ],
    retailer: [
      { key: "overview", label: "Overview" },
      { key: "inventory", label: "Inventory" },
      { key: "verification", label: "Verification" },
      { key: "stakeholders", label: "Stakeholders" }
    ],
    consumer: [
      { key: "overview", label: "Overview" },
      { key: "ownership", label: "Ownership" },
      { key: "stakeholders", label: "Stakeholders" }
    ]
  };

  return catalog[role] ?? catalog.consumer;
}

function getDefaultViewForRole(role) {
  const defaults = {
    admin: "overview",
    manufacturer: "register",
    distributor: "logistics",
    retailer: "inventory",
    consumer: "ownership"
  };

  return defaults[role] ?? "overview";
}

function getDirectoryAccounts(role, options = {}) {
  const { activeOnly = true } = options;
  if (!state.dashboard) {
    return [];
  }

  return state.dashboard.directory.filter((account) => {
    if (account.role !== role) {
      return false;
    }

    if (activeOnly && account.status !== "ACTIVE") {
      return false;
    }

    return true;
  });
}

function getAccountCreationOptions() {
  return state.dashboard?.stakeholderCreation?.options ?? [];
}

function getCreatedAccounts() {
  if (!state.dashboard) {
    return [];
  }

  if (state.dashboard.currentUser.role === "admin") {
    return state.dashboard.accounts.filter((account) => account.role !== "admin");
  }

  return state.dashboard.accounts.filter((account) => account.id !== state.dashboard.currentUser.id);
}

function getKnownAccount(accountId) {
  if (!accountId || !state.dashboard) {
    return null;
  }

  const accountLists = [
    state.dashboard.currentUser ? [state.dashboard.currentUser] : [],
    state.dashboard.accounts ?? [],
    state.dashboard.directory ?? []
  ];

  for (const accounts of accountLists) {
    const match = accounts.find((account) => account.id === accountId);
    if (match) {
      return match;
    }
  }

  return null;
}

function setGpsFields(prefix, gps) {
  const latInput = document.getElementById(`${prefix}Lat`);
  const lonInput = document.getElementById(`${prefix}Lon`);
  if (!latInput || !lonInput || !gps) {
    return;
  }

  latInput.value = gps.lat ?? "";
  lonInput.value = gps.lon ?? "";
}

function syncGpsFieldsFromAccountSelection(select) {
  const prefix = select?.dataset?.gpsTargetPrefix;
  if (!prefix) {
    return;
  }

  const account = getKnownAccount(select.value);
  if (!account?.registeredGps) {
    return;
  }

  setGpsFields(prefix, account.registeredGps);
}

function syncCreateAccountForm(roleSelect) {
  if (!roleSelect?.form) {
    return;
  }

  const form = roleSelect.form;
  const options = getAccountCreationOptions();
  const selectedOption =
    options.find((option) => option.role === roleSelect.value) ?? options[0] ?? null;
  const ownerTierField = form.querySelector("[data-owner-tier-field]");
  const ownerTierInput = form.querySelector("[name='postSaleOrdinal']");
  const submitButton = form.querySelector("[data-create-account-button]");
  const requiresOwnerTier = selectedOption?.role === "consumer";
  const currentUser = state.dashboard?.currentUser;

  if (ownerTierField) {
    ownerTierField.hidden = !requiresOwnerTier;
  }

  if (ownerTierInput) {
    if (requiresOwnerTier) {
      const nextOwnerTier = selectedOption?.postSaleOrdinal ?? ownerTierInput.value ?? 1;
      ownerTierInput.value = String(nextOwnerTier || 1);
      ownerTierInput.readOnly = currentUser?.role !== "admin";
    } else {
      ownerTierInput.value = "";
      ownerTierInput.readOnly = false;
    }
  }

  if (submitButton) {
    submitButton.textContent = selectedOption
      ? `Create ${selectedOption.roleLabel}`
      : "Create Stakeholder";
  }
}

async function runAudit() {
  const selected = getSelectedProduct();
  if (!selected) {
    return;
  }

  await perform(async () => {
    state.lastAudit = await api(`/api/products/${encodeURIComponent(selected.id)}/audit`);
    toast("Audit report refreshed.");
  });
}

function clearSession() {
  state.sessionToken = "";
  state.dashboard = null;
  state.detailsByProductId = {};
  state.selectedProductId = initialParams.get("pid");
  state.activeView = null;
  state.lastAudit = null;
  state.lastVerification = null;
  localStorage.removeItem(TOKEN_KEY);
  syncUrl();
  render();
}

function syncUrl() {
  const url = new URL(window.location.href);
  const selected = getSelectedProduct();

  if (state.dashboard && selected && state.activeView === "verification") {
    url.pathname = "/verify";
    url.searchParams.set("pid", selected.id);
    url.searchParams.set("t", state.verifyTokenOverride || selected.token);
  } else {
    url.pathname = "/";
    url.searchParams.delete("pid");
    url.searchParams.delete("t");
  }

  window.history.replaceState({}, "", url);
}

function render() {
  if (!state.dashboard) {
    root.innerHTML = renderAuth();
    renderToast();
    return;
  }

  const currentUser = state.dashboard.currentUser;
  const views = getViewsForRole(currentUser.role);
  const selected = getSelectedProduct();
  const details = getSelectedDetails();

  root.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">DB</div>
          <div>
            <h1>DBPAS</h1>
            <p>${escapeHtml(state.dashboard.panel.title)}</p>
          </div>
        </div>
        <div class="topbar-actions">
          <span class="badge role-badge">${escapeHtml(currentUser.roleLabel)}</span>
          <div class="account-chip">
            <strong>${escapeHtml(currentUser.displayName)}</strong>
            <span>@${escapeHtml(currentUser.username)}</span>
          </div>
          <button class="ghost-button" type="button" data-logout>Logout</button>
        </div>
      </header>

      <nav class="tab-row">
        ${views.map((view) => renderViewButton(view)).join("")}
      </nav>

      <div class="workspace-grid">
        <aside class="side-panel">
          ${renderSidebar(currentUser, selected)}
        </aside>

        <section class="main-panel">
          ${renderRoleView(currentUser.role, selected, details)}
        </section>
      </div>
    </main>
  `;
  renderToast();
}

function renderAuth() {
  const setupHint = state.publicBootstrap?.auth?.setupHint;

  return `
    <main class="auth-shell">
      <section class="auth-hero">
        <div class="hero-copy">
          <div class="eyebrow">Blockchain Product Authentication</div>
          <h1>Clean stakeholder access for the full DBPAS supply chain.</h1>
          <p>
            Sign in to your role-specific panel to manage registration, logistics,
            store verification, or consumer ownership from one controlled system.
          </p>
          <div class="feature-row">
            ${renderFeature("Admin governance", "Create and control all stakeholder accounts.")}
            ${renderFeature("Role panels", "A separate operating surface for each stakeholder.")}
            ${renderFeature("GNQR security", "Geo-bound nonce history and product verification.")}
          </div>
        </div>
        <form id="login-form" class="auth-card">
          <div class="section-header">
            <div>
              <div class="mini-title">Account Access</div>
              <h2>Sign In</h2>
            </div>
          </div>
          <div class="field">
            <label for="username">Username</label>
            <input id="username" name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          ${setupHint ? `
            <div class="hint-card">
              <strong>Initial admin access</strong>
              <p>Username: <span class="mono">${escapeHtml(setupHint.username)}</span></p>
              <p>Password: <span class="mono">${escapeHtml(setupHint.password)}</span></p>
            </div>
          ` : ""}
          <button class="action-button full-width" type="submit">Enter Dashboard</button>
        </form>
      </section>
    </main>
  `;
}

function renderSidebar(currentUser, selected) {
  return `
    <section class="panel-card">
      <div class="mini-title">Account</div>
      <h2>${escapeHtml(currentUser.displayName)}</h2>
      <p class="helper">${escapeHtml(state.dashboard.panel.description)}</p>
      <div class="stats-grid compact">
        ${renderMetric(state.dashboard.stats.products, "Visible Products")}
        ${renderMetric(state.dashboard.stats.ownedProducts, "Owned")}
        ${renderMetric(state.dashboard.stats.historyEvents, "History")}
        ${renderMetric(state.dashboard.stats.activeAccounts, "Active Accounts")}
      </div>
    </section>

    <section class="panel-card">
      <div class="section-header">
        <div>
          <div class="mini-title">Products</div>
          <h2>${state.dashboard.products.length ? "Relevant Assets" : "No Assets Yet"}</h2>
        </div>
      </div>
      ${state.dashboard.products.length
        ? `
          <div class="stack-list">
            ${state.dashboard.products.map((product) => renderProductListItem(product)).join("")}
          </div>
        `
        : renderEmptyState("Products will appear here as soon as your role becomes part of the supply-chain flow.")}
    </section>

    ${selected ? `
      <section class="panel-card">
        <div class="mini-title">Selected Product</div>
        <h2>${escapeHtml(selected.metadata.productName)}</h2>
        <dl class="info-grid">
          <div><dt>Owner</dt><dd>${escapeHtml(selected.ownerDisplayName)}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(selected.status)}</dd></div>
          <div><dt>Batch</dt><dd>${escapeHtml(selected.metadata.batchNumber)}</dd></div>
          <div><dt>Nonce</dt><dd class="mono">${escapeHtml(selected.currentNoncePreview)}</dd></div>
        </dl>
      </section>
    ` : ""}
  `;
}

function renderRoleView(role, selected, details) {
  if (role === "admin") {
    return renderAdminView(selected, details);
  }

  if (role === "manufacturer") {
    return renderManufacturerView(selected, details);
  }

  if (role === "distributor") {
    return renderDistributorView(selected, details);
  }

  if (role === "retailer") {
    return renderRetailerView(selected, details);
  }

  return renderConsumerView(selected, details);
}

function renderAdminView(selected, details) {
  if (state.activeView === "accounts") {
    return renderStakeholderManagementView();
  }

  if (state.activeView === "products") {
    return `
      <div class="section-stack">
        <section class="hero-card">
          <div class="eyebrow">Supply Chain Monitor</div>
          <h2>See every product and every ledger event in one place.</h2>
          <p>Admin users can inspect all assets without participating directly in ownership transfer.</p>
        </section>
        ${selected ? renderProductInspector(selected, details) : renderEmptyState("No products have been registered yet.")}
      </div>
    `;
  }

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">System Overview</div>
        <h2>A clean DBPAS runtime with governed stakeholder accounts.</h2>
        <p>The admin account is the only bootstrap user. Every other stakeholder is created from here.</p>
      </section>
      <section class="stats-grid">
        ${renderMetric(state.dashboard.stats.accounts, "Total Accounts")}
        ${renderMetric(state.dashboard.stats.activeAccounts, "Active Accounts")}
        ${renderMetric(state.dashboard.stats.products, "Tracked Products")}
        ${renderMetric(state.dashboard.stats.historyEvents, "Visible Events")}
      </section>
      <section class="panel-card">
        <div class="section-header">
          <div>
            <div class="mini-title">Recent Activity</div>
            <h2>Ledger Feed</h2>
          </div>
        </div>
        ${renderHistoryList(state.dashboard.recentHistory)}
      </section>
    </div>
  `;
}

function renderStakeholderManagementView() {
  const currentUser = state.dashboard.currentUser;
  const options = getAccountCreationOptions();

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">${escapeHtml(currentUser.roleLabel)}</div>
        <h2>${escapeHtml(getStakeholderHeadline(currentUser))}</h2>
        <p>${escapeHtml(getStakeholderDescription(currentUser, options))}</p>
      </section>
      <section class="split-grid">
        ${renderCreateAccountForm()}
        ${renderAccountRegistry()}
      </section>
    </div>
  `;
}

function renderManufacturerView(selected, details) {
  if (state.activeView === "stakeholders") {
    return renderStakeholderManagementView();
  }

  if (state.activeView === "products") {
    return `
      <div class="section-stack">
        <section class="hero-card">
          <div class="eyebrow">Manufacturer Operations</div>
          <h2>Manage registered assets and initiate atomic distributor handoffs.</h2>
          <p>Every product starts here with a GNQR nonce, destination hash, and minimum transit bound.</p>
        </section>
        ${selected ? `
          ${renderProductInspector(selected, details)}
          ${selected.actions?.canHandoff ? renderHandoffForm(selected, "manufacturer") : ""}
        ` : renderEmptyState("Register a product first, then select it from the sidebar to continue the chain.")}
      </div>
    `;
  }

  if (state.activeView === "register") {
    return `
      <div class="section-stack">
        <section class="hero-card">
          <div class="eyebrow">Product Registration</div>
          <h2>Register a new product from the manufacturing checkpoint.</h2>
          <p>The initial nonce binds the factory GPS, first distributor destination, and transit-time bound on the ledger.</p>
        </section>
        ${renderRegisterProductForm()}
      </div>
    `;
  }

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">Manufacturer Dashboard</div>
        <h2>Your products start the chain here.</h2>
        <p>Create product assets, inspect GNQR payloads, and hand off to approved distributors.</p>
      </section>
      <section class="stats-grid">
        ${renderMetric(state.dashboard.products.length, "Visible Products")}
        ${renderMetric(state.dashboard.products.filter((product) => product.ownerRole === "manufacturer").length, "Currently Owned")}
        ${renderMetric(getDirectoryAccounts("distributor").length, "Distributors")}
        ${renderMetric(state.dashboard.recentHistory.length, "Recent Events")}
      </section>
    </div>
  `;
}

function renderDistributorView(selected, details) {
  if (state.activeView === "stakeholders") {
    return renderStakeholderManagementView();
  }

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">Distributor Logistics</div>
        <h2>Receive authenticated inventory and route it to retailers atomically.</h2>
        <p>Each distributor checkpoint advances both the nonce chain and product custody in one committed event.</p>
      </section>
      ${selected ? `
        ${renderProductInspector(selected, details)}
        ${selected.actions?.canHandoff ? renderHandoffForm(selected, "distributor") : renderEmptyState("Select a distributor-owned product to route it onward.") }
      ` : renderEmptyState("Products assigned to your distribution account will appear here.")}
    </div>
  `;
}

function renderRetailerView(selected, details) {
  if (state.activeView === "stakeholders") {
    return renderStakeholderManagementView();
  }

  if (state.activeView === "verification") {
    return `
      <div class="section-stack">
        <section class="hero-card">
          <div class="eyebrow">Retail Verification</div>
          <h2>Inspect GNQR labels and audit atomic checkpoint readiness.</h2>
          <p>Retailers can review the revised GNQR chain, destination hash, and transit-time guard before completing a sale.</p>
        </section>
        ${selected ? renderVerificationWorkspace(selected, details) : renderEmptyState("Select a retail-held product to inspect its QR identity.")}
      </div>
    `;
  }

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">Retail Operations</div>
        <h2>Complete atomic sale checkpoints to consumer accounts.</h2>
        <p>The revised DBPAS flow advances the GNQR nonce and consumer ownership together in a single sale event.</p>
      </section>
      ${selected ? `
        ${renderProductInspector(selected, details)}
        ${selected.actions?.canTransfer ? renderTransferForm("retailer") : ""}
      ` : renderEmptyState("Products handed off to your retail account will appear here.")}
    </div>
  `;
}

function renderConsumerView(selected, details) {
  if (state.activeView === "stakeholders") {
    return renderStakeholderManagementView();
  }

  return `
    <div class="section-stack">
      <section class="hero-card">
        <div class="eyebrow">Consumer Ownership</div>
        <h2>Manage owned assets and secondary-market transfers.</h2>
        <p>Owners verify the current GNQR state, create the next downstream owner, and propagate provenance with atomic transfer.</p>
      </section>
      ${selected ? `
        ${renderProductInspector(selected, details)}
        ${renderVerificationWorkspace(selected, details, true)}
        ${selected.actions?.canTransfer ? renderTransferForm("consumer") : ""}
      ` : renderEmptyState("Your purchased products will appear here after a retailer transfers ownership.")}
    </div>
  `;
}

function getStakeholderHeadline(currentUser) {
  if (currentUser.role === "admin") {
    return "Control stakeholder creation across the entire DBPAS network.";
  }

  if (currentUser.role === "manufacturer") {
    return "Create distributor accounts for the next step in your supply chain.";
  }

  if (currentUser.role === "distributor") {
    return "Create retailer accounts and expand your downstream logistics network.";
  }

  if (currentUser.role === "retailer") {
    return "Create 1st Owner accounts for post-sale lifecycle onboarding.";
  }

  return `Create the next owner stage after your ${currentUser.roleLabel.toLowerCase()} account.`;
}

function getStakeholderDescription(currentUser, options) {
  if (!options.length) {
    return "This account cannot create additional downstream stakeholders.";
  }

  const labels = options.map((option) => option.roleLabel).join(", ");
  if (currentUser.role === "admin") {
    return `Admin can create any stakeholder role. Available options: ${labels}.`;
  }

  return `This account can create any number of downstream stakeholders for the next supply-chain role: ${labels}.`;
}

function renderCreateAccountForm() {
  const currentUser = state.dashboard.currentUser;
  const options = getAccountCreationOptions();
  const selectedOption = options[0] ?? null;
  const suggestedOwnerTier = selectedOption?.postSaleOrdinal ?? "";
  const showOwnerTier = selectedOption?.role === "consumer";

  if (!options.length) {
    return `
      <section class="panel-card">
        <div class="section-header">
          <div>
            <div class="mini-title">Stakeholder Creation</div>
            <h2>No Downstream Roles Available</h2>
          </div>
        </div>
        ${renderEmptyState("This account cannot create another stakeholder stage.")}
      </section>
    `;
  }

  return `
    <form id="create-account-form" class="panel-card form-card">
      <div class="section-header">
        <div>
          <div class="mini-title">New Stakeholder</div>
          <h2>Create Account</h2>
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="displayName">Display Name</label>
          <input id="displayName" name="displayName" required />
        </div>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" required />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required />
        </div>
        <div class="field">
          <label for="role">Role</label>
          <select id="role" name="role" data-role-select>
            ${options.map((option) => `<option value="${escapeAttribute(option.role)}">${escapeHtml(option.roleLabel)}</option>`).join("")}
          </select>
        </div>
        <div class="field full-span">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" />
        </div>
        <div class="field" data-owner-tier-field ${showOwnerTier ? "" : "hidden"}>
            <label for="postSaleOrdinal">Owner Tier</label>
            <input
              id="postSaleOrdinal"
              name="postSaleOrdinal"
              type="number"
              min="1"
              value="${escapeAttribute(suggestedOwnerTier || "")}"
              ${currentUser.role === "admin" && showOwnerTier ? "" : "readonly"}
            />
          </div>
        ${renderGpsFields("account", "Registered GPS", { lat: "", lon: "" })}
      </div>
      <button class="action-button" type="submit" data-create-account-button>
        ${escapeHtml(selectedOption ? `Create ${selectedOption.roleLabel}` : "Create Stakeholder")}
      </button>
    </form>
  `;
}

function renderAccountRegistry() {
  const currentUser = state.dashboard.currentUser;
  const accounts = getCreatedAccounts();
  return `
    <section class="panel-card">
      <div class="section-header">
        <div>
          <div class="mini-title">Stakeholders</div>
          <h2>${currentUser.role === "admin" ? "Account Registry" : "Accounts You Created"}</h2>
        </div>
      </div>
      ${accounts.length
        ? `
          <div class="stack-list">
            ${accounts.map(renderAccountRow).join("")}
          </div>
        `
        : renderEmptyState(currentUser.role === "admin" ? "No stakeholder accounts have been created yet." : "You have not created any downstream stakeholder accounts yet.")}
    </section>
  `;
}

function renderRegisterProductForm() {
  const currentUser = state.dashboard.currentUser;
  const distributors = getDirectoryAccounts("distributor");
  const initialDestinationGps = distributors[0]?.registeredGps ?? { lat: "", lon: "" };

  return `
    <form id="register-product-form" class="panel-card form-card">
      <div class="section-header">
        <div>
          <div class="mini-title">Register Asset</div>
          <h2>Manufacturer Minting Flow</h2>
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="productId">Product ID</label>
          <input id="productId" name="productId" placeholder="Optional custom identifier" />
        </div>
        <div class="field">
          <label for="productName">Product Name</label>
          <input id="productName" name="productName" required />
        </div>
        <div class="field">
          <label for="batchNumber">Batch Number</label>
          <input id="batchNumber" name="batchNumber" required />
        </div>
        <div class="field">
          <label for="manufacturingDate">Manufacturing Date</label>
          <input id="manufacturingDate" name="manufacturingDate" type="date" />
        </div>
        <div class="field">
          <label for="category">Category</label>
          <input id="category" name="category" />
        </div>
        <div class="field">
          <label for="destinationAccountId">Initial Distributor</label>
          <select
            id="destinationAccountId"
            name="destinationAccountId"
            data-gps-target-prefix="registerDestination"
            required
          >
            ${distributors.length
              ? distributors.map((account) => `<option value="${escapeAttribute(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")
              : `<option value="">Create a distributor account first</option>`}
          </select>
        </div>
        <div class="field full-span">
          <label for="description">Description</label>
          <textarea id="description" name="description"></textarea>
        </div>
        ${renderGpsFields("factory", "Factory GPS", currentUser.registeredGps)}
        ${renderGpsFields("registerDestination", "Initial Destination GPS", initialDestinationGps)}
      </div>
      <button class="action-button" type="submit" ${distributors.length ? "" : "disabled"}>Register Product</button>
    </form>
  `;
}

function renderHandoffForm(selected, actorRole) {
  const receivers = actorRole === "manufacturer"
    ? getDirectoryAccounts("distributor")
    : getDirectoryAccounts("retailer");
  const destinations = getDirectoryAccounts("retailer");
  const currentGps = state.dashboard.currentUser.registeredGps;
  const initialDestinationGps = destinations[0]?.registeredGps ?? currentGps;

  return `
    <form id="handoff-form" class="panel-card form-card">
      <div class="section-header">
        <div>
          <div class="mini-title">Chain Handoff</div>
          <h2>${actorRole === "manufacturer" ? "Send to Distributor" : "Send to Retailer"}</h2>
        </div>
        ${renderStatusBadge(selected.status)}
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="receiverAccountId">Receiver</label>
          <select id="receiverAccountId" name="receiverAccountId">
            ${receivers.map((account) => `<option value="${escapeAttribute(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="destinationAccountId">Destination Checkpoint</label>
          <select
            id="destinationAccountId"
            name="destinationAccountId"
            data-gps-target-prefix="handoffDestination"
          >
            ${destinations.map((account) => `<option value="${escapeAttribute(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")}
          </select>
        </div>
        ${renderGpsFields("handoff", "Current Checkpoint GPS", currentGps)}
        ${renderGpsFields("handoffDestination", "Next Destination GPS", initialDestinationGps)}
      </div>
      <button class="action-button" type="submit" ${receivers.length && destinations.length ? "" : "disabled"}>Commit Handoff</button>
    </form>
  `;
}

function renderTransferForm(role) {
  const currentUser = state.dashboard.currentUser;
  const targetOwnerOrdinal = role === "retailer" ? 1 : (currentUser.postSaleOrdinal ?? 1) + 1;
  const receivers = getDirectoryAccounts("consumer").filter(
    (account) =>
      account.id !== currentUser.id && account.postSaleOrdinal === targetOwnerOrdinal
  );
  const title = role === "retailer" ? "Atomic Sale Checkpoint" : "Atomic Provenance Transfer";
  const buttonLabel = role === "retailer" ? "Commit Sale" : "Commit Transfer";
  const helper =
    role === "retailer"
      ? "This sale advances the GNQR nonce and transfers the asset to a 1st Owner account in one atomic step."
      : "This secondary-market transfer advances the GNQR nonce and provenance history to the next owner stage in one atomic step.";
  const initialDestinationGps = receivers[0]?.registeredGps ?? currentUser.registeredGps;

  return `
    <form id="transfer-form" class="panel-card form-card">
      <div class="section-header">
        <div>
          <div class="mini-title">Ownership Transfer</div>
          <h2>${title}</h2>
        </div>
      </div>
      <p class="helper">${helper}</p>
      <div class="form-grid">
        <div class="field">
          <label for="receiverAccountId">Receiver</label>
          <select
            id="receiverAccountId"
            name="receiverAccountId"
            data-gps-target-prefix="transferDestination"
          >
            ${receivers.map((account) => `<option value="${escapeAttribute(account.id)}">${escapeHtml(account.displayName)}</option>`).join("")}
          </select>
        </div>
        ${renderGpsFields("transfer", "Transfer Event GPS", state.dashboard.currentUser.registeredGps)}
        ${renderGpsFields("transferDestination", "Destination GPS", initialDestinationGps)}
      </div>
      <button class="action-button" type="submit" ${receivers.length ? "" : "disabled"}>${buttonLabel}</button>
    </form>
  `;
}

function renderVerificationWorkspace(selected, details, compact = false) {
  const verification = state.lastVerification;
  const audit = state.lastAudit || details?.audit;
  const defaultGps = state.dashboard.currentUser.registeredGps;
  const qrImageDataUrl = details?.product?.qrImageDataUrl || selected.qrImageDataUrl || "";
  const qrDownloadName = details?.product?.qrDownloadName || selected.qrDownloadName || `${selected.id}-qr.svg`;
  const manufacturerQrPayload =
    details?.product?.manufacturerQrPayload || selected.manufacturerQrPayload || selected.localVerifyPath;
  const dynamicQrPayload = details?.product?.qrPayload || selected.qrPayload || "";

  return `
    <div class="${compact ? "section-stack" : "verification-grid"}">
      <section class="panel-card qr-card">
        <div class="section-header">
          <div>
            <div class="mini-title">Manufacturer QR Label</div>
            <h2>${escapeHtml(selected.metadata.productName)}</h2>
          </div>
          ${renderStatusBadge(selected.status)}
        </div>
        <div class="qr-visual">${
          qrImageDataUrl
            ? `<img src="${escapeAttribute(qrImageDataUrl)}" alt="Scannable QR code for ${escapeAttribute(selected.metadata.productName)}" />`
            : buildPseudoQrSvg(manufacturerQrPayload)
        }</div>
        <p class="helper">This QR image stays fixed after manufacturer generation and resolves the product identity.</p>
        <p class="mono payload-text">${escapeHtml(manufacturerQrPayload)}</p>
        <div class="mini-title">Current Checkpoint Payload</div>
        <p class="mono payload-text">${escapeHtml(dynamicQrPayload)}</p>
        <div class="button-row">
          <button class="ghost-button" type="button" data-copy="${escapeAttribute(dynamicQrPayload)}">Copy Dynamic Payload</button>
          <button class="ghost-button" type="button" data-copy="${escapeAttribute(manufacturerQrPayload)}">Copy Manufacturer QR</button>
          ${qrImageDataUrl ? `<a class="link-button" href="${escapeAttribute(qrImageDataUrl)}" download="${escapeAttribute(qrDownloadName)}">Download QR</a>` : ""}
          <button class="ghost-button" type="button" data-run-audit>Run Audit</button>
        </div>
      </section>

      <section class="section-stack">
        <form id="verify-form" class="panel-card form-card">
          <div class="section-header">
            <div>
              <div class="mini-title">Verification</div>
              <h2>Execute Checks</h2>
            </div>
          </div>
          <div class="form-grid">
            <div class="field full-span">
              <label for="token">QR Token</label>
              <input id="token" name="token" value="${escapeAttribute(state.verifyTokenOverride || selected.token)}" required />
            </div>
            ${renderGpsFields("verify", "Scanner GPS", defaultGps)}
          </div>
          <button class="action-button" type="submit">Verify Product</button>
        </form>
        ${verification ? renderVerificationReport("Verification Result", verification) : ""}
        ${audit ? renderVerificationReport("Audit Report", audit) : ""}
      </section>
    </div>
  `;
}

function renderVerificationReport(title, report) {
  return `
    <section class="panel-card">
      <div class="section-header">
        <div>
          <div class="mini-title">${escapeHtml(title)}</div>
          <h2>${escapeHtml(report.status)}</h2>
        </div>
        ${renderStatusBadge(report.status)}
      </div>
      <dl class="info-grid">
        <div><dt>Mode</dt><dd>${escapeHtml(report.mode)}</dd></div>
        <div><dt>Chain Length</dt><dd>${report.chainLength}</dd></div>
        <div><dt>Provenance Hops</dt><dd>${report.provenanceHops ?? 0}</dd></div>
        <div><dt>Min Transit</dt><dd>${report.minTransitSeconds ?? 0} s</dd></div>
        <div><dt>Current Owner</dt><dd>${escapeHtml(report.currentOwner.displayName)}</dd></div>
        <div><dt>Retailer</dt><dd>${escapeHtml(report.retailer?.displayName ?? "Not assigned")}</dd></div>
        <div><dt>Valid After</dt><dd>${escapeHtml(report.validAfter ? new Date(report.validAfter).toLocaleString() : "Immediate")}</dd></div>
        <div><dt>Dest Hash</dt><dd class="mono">${escapeHtml(report.destinationHashPreview ?? "Unavailable")}</dd></div>
      </dl>
      <div class="stack-list">
        ${report.checks.map((check) => `
          <article class="check-card ${check.ok ? "is-pass" : "is-fail"}">
            <strong>${escapeHtml(check.label)}</strong>
            <p>${escapeHtml(check.detail)}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderProductInspector(selected, details) {
  const qrImageDataUrl = details?.product?.qrImageDataUrl || selected.qrImageDataUrl || "";
  const qrDownloadName = details?.product?.qrDownloadName || selected.qrDownloadName || `${selected.id}-qr.svg`;
  const manufacturerQrPayload =
    details?.product?.manufacturerQrPayload || selected.manufacturerQrPayload || selected.localVerifyPath;
  const dynamicQrPayload = details?.product?.qrPayload || selected.qrPayload || "";

  return `
    <section class="split-grid inspector-grid">
      <article class="panel-card">
        <div class="section-header">
          <div>
            <div class="mini-title">Product Detail</div>
            <h2>${escapeHtml(selected.metadata.productName)}</h2>
          </div>
          ${renderStatusBadge(selected.status)}
        </div>
        <dl class="info-grid">
          <div><dt>Product ID</dt><dd class="mono">${escapeHtml(selected.id)}</dd></div>
          <div><dt>Current Owner</dt><dd>${escapeHtml(selected.ownerDisplayName)}</dd></div>
          <div><dt>Manufacturer</dt><dd>${escapeHtml(selected.manufacturerDisplayName)}</dd></div>
          <div><dt>Batch</dt><dd>${escapeHtml(selected.metadata.batchNumber)}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(selected.metadata.category)}</dd></div>
          <div><dt>Checkpoint</dt><dd>${selected.checkpointIndex}</dd></div>
          <div><dt>Transfers</dt><dd>${selected.transferCount ?? 0}</dd></div>
          <div><dt>Min Transit</dt><dd>${selected.minTransitSeconds ?? 0} s</dd></div>
          <div><dt>Token</dt><dd class="mono">${escapeHtml(selected.tokenPreview)}</dd></div>
          <div><dt>Nonce</dt><dd class="mono">${escapeHtml(selected.currentNoncePreview)}</dd></div>
          <div><dt>Dest Hash</dt><dd class="mono">${escapeHtml(selected.gpsDestHashPreview ?? "Unavailable")}</dd></div>
        </dl>
        <div class="button-row">
          <button class="ghost-button" type="button" data-copy="${escapeAttribute(dynamicQrPayload)}">Copy Dynamic Payload</button>
          <button class="ghost-button" type="button" data-copy="${escapeAttribute(manufacturerQrPayload)}">Copy Manufacturer QR</button>
          ${qrImageDataUrl ? `<a class="link-button" href="${escapeAttribute(qrImageDataUrl)}" download="${escapeAttribute(qrDownloadName)}">Download QR</a>` : ""}
          <a class="link-button" href="${selected.localVerifyPath}">Open Verify Route</a>
        </div>
        <p class="helper">Manufacturer QR image remains fixed; the current GNQR payload below changes after every checkpoint.</p>
        <p class="mono payload-text">${escapeHtml(dynamicQrPayload)}</p>
      </article>

      <article class="panel-card">
        <div class="section-header">
          <div>
            <div class="mini-title">Product History</div>
            <h2>Ledger Timeline</h2>
          </div>
        </div>
        ${renderHistoryList(details?.history ?? [])}
      </article>
    </section>
  `;
}

function renderHistoryList(entries) {
  if (!entries.length) {
    return renderEmptyState("No ledger events to show yet.");
  }

  return `
    <div class="stack-list">
      ${entries
        .slice()
        .reverse()
        .map(
          (entry) => `
            <article class="history-card">
              <div class="section-header">
                <strong>${escapeHtml(entry.type.replaceAll("_", " "))}</strong>
                <span class="badge">${escapeHtml(entry.status)}</span>
              </div>
              <p>${escapeHtml(entry.actorDisplayName)} | ${new Date(entry.timestamp).toLocaleString()}</p>
              <p>${escapeHtml(entry.fromOwnerDisplayName ?? "System")} -> ${escapeHtml(entry.toOwnerDisplayName ?? "System")}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderProductListItem(product) {
  return `
    <button class="list-button" type="button" data-product-id="${escapeAttribute(product.id)}">
      <article class="list-card ${product.id === state.selectedProductId ? "is-active" : ""}">
        <div class="section-header">
          <div>
            <div class="mini-title">${escapeHtml(product.metadata.category)}</div>
            <h3>${escapeHtml(product.metadata.productName)}</h3>
          </div>
          ${renderStatusBadge(product.status)}
        </div>
        <p>${escapeHtml(product.ownerDisplayName)} currently owns this asset.</p>
      </article>
    </button>
  `;
}

function renderAccountRow(account) {
  const canManageStatus = state.dashboard.currentUser.role === "admin";
  return `
    <article class="list-card">
      <div class="section-header">
        <div>
          <div class="mini-title">${escapeHtml(account.roleLabel)}</div>
          <h3>${escapeHtml(account.displayName)}</h3>
        </div>
        <span class="badge ${account.status === "ACTIVE" ? "is-good" : "is-muted"}">${escapeHtml(account.status)}</span>
      </div>
      <p>@${escapeHtml(account.username)} | ${escapeHtml(account.org)}</p>
      ${account.postSaleOrdinal ? `<p class="helper">Ownership Stage: ${escapeHtml(account.roleLabel)}</p>` : ""}
      <p class="helper">GPS: ${escapeHtml(account.registeredGps.lat.toFixed(6))}, ${escapeHtml(account.registeredGps.lon.toFixed(6))}</p>
      ${canManageStatus ? `
        <div class="button-row">
          <button
            class="ghost-button"
            type="button"
            data-account-id="${escapeAttribute(account.id)}"
            data-next-status="${account.status === "ACTIVE" ? "INACTIVE" : "ACTIVE"}"
          >
            ${account.status === "ACTIVE" ? "Deactivate" : "Activate"}
          </button>
        </div>
      ` : ""}
    </article>
  `;
}

function renderViewButton(view) {
  return `
    <button
      type="button"
      data-view="${view.key}"
      class="tab-button ${state.activeView === view.key ? "is-active" : ""}"
    >
      ${escapeHtml(view.label)}
    </button>
  `;
}

function renderMetric(value, label) {
  return `
    <div class="metric-card">
      <strong>${value}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function renderFeature(title, description) {
  return `
    <article class="feature-card">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
    </article>
  `;
}

function renderStatusBadge(status) {
  const normalized = String(status).toUpperCase();
  let className = "badge";
  if (normalized === "AUTHENTIC" || normalized === "OWNED" || normalized === "RETAIL_READY") {
    className += " is-good";
  } else if (normalized.includes("CLONE")) {
    className += " is-warn";
  } else if (normalized.includes("TAMPER") || normalized === "INACTIVE") {
    className += " is-bad";
  } else {
    className += " is-muted";
  }

  return `<span class="${className}">${escapeHtml(normalized)}</span>`;
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderGpsFields(prefix, label, gps = { lat: "", lon: "" }) {
  return `
    <div class="field">
      <label for="${prefix}Lat">${escapeHtml(label)} Latitude</label>
      <input id="${prefix}Lat" name="${prefix}Lat" type="number" step="0.000001" value="${gps.lat ?? ""}" required />
    </div>
    <div class="field">
      <label for="${prefix}Lon">${escapeHtml(label)} Longitude</label>
      <input id="${prefix}Lon" name="${prefix}Lon" type="number" step="0.000001" value="${gps.lon ?? ""}" required />
    </div>
    <div class="field full-span">
      <button class="ghost-button geolocate-button" type="button" data-geolocate-prefix="${escapeAttribute(prefix)}">
        Use Current Location
      </button>
    </div>
  `;
}

function readGps(formData, prefix, fallback = { lat: 0, lon: 0 }) {
  const lat = formData.get(`${prefix}Lat`);
  const lon = formData.get(`${prefix}Lon`);

  return {
    lat: lat === null || lat === "" ? fallback.lat : Number(lat),
    lon: lon === null || lon === "" ? fallback.lon : Number(lon)
  };
}

function buildPseudoQrSvg(text) {
  const size = 29;
  const cell = 4;
  const finderCells = new Set();

  function key(x, y) {
    return `${x}:${y}`;
  }

  function addFinder(startX, startY) {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const border = x === 0 || x === 6 || y === 0 || y === 6;
        const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (border || center) {
          finderCells.add(key(startX + x, startY + y));
        }
      }
    }
  }

  addFinder(1, 1);
  addFinder(size - 8, 1);
  addFinder(1, size - 8);

  let seed = 2166136261;
  for (const character of text) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }

  function nextValue() {
    seed += 0x6d2b79f5;
    let current = seed;
    current = Math.imul(current ^ (current >>> 15), current | 1);
    current ^= current + Math.imul(current ^ (current >>> 7), current | 61);
    return ((current ^ (current >>> 14)) >>> 0) / 4294967296;
  }

  const rects = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const reserved = finderCells.has(key(x, y));
      const timing =
        (x === 8 && y > 7 && y < size - 8) ||
        (y === 8 && x > 7 && x < size - 8);
      const isDark = reserved || timing ? ((x + y) % 2 === 0 || reserved) : nextValue() > 0.52;

      if (isDark) {
        rects.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" rx="1" />`);
      }
    }
  }

  return `
    <svg viewBox="0 0 ${size * cell} ${size * cell}" role="img" aria-label="GNQR visual">
      <rect width="${size * cell}" height="${size * cell}" rx="18" fill="#ffffff"></rect>
      <g fill="#102131">${rects.join("")}</g>
    </svg>
  `;
}

async function autofillCurrentLocation(prefix, button) {
  const latInput = document.getElementById(`${prefix}Lat`);
  const lonInput = document.getElementById(`${prefix}Lon`);
  if (!latInput || !lonInput) {
    toast("Could not find GPS fields for this form.", "error");
    return;
  }

  if (!navigator.geolocation) {
    toast("Browser geolocation is not available on this device.", "error");
    return;
  }

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Detecting...";

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000
      });
    });

    latInput.value = position.coords.latitude.toFixed(6);
    lonInput.value = position.coords.longitude.toFixed(6);
    toast("Current location detected.");
  } catch (error) {
    let message = "Location detection failed.";
    if (error?.code === 1) {
      message = "Location permission was denied.";
    } else if (error?.code === 2) {
      message = "Current location could not be determined.";
    } else if (error?.code === 3) {
      message = "Location detection timed out.";
    }
    toast(message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function perform(action) {
  if (state.loading) {
    return;
  }

  state.loading = true;
  try {
    await action();
  } catch (error) {
    toast(error.message ?? "Something went wrong.", "error");
  } finally {
    state.loading = false;
    render();
  }
}

async function api(pathname, options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (!options.public && state.sessionToken) {
    headers.Authorization = `Bearer ${state.sessionToken}`;
  }

  const response = await fetch(pathname, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !options.public) {
      clearSession();
    }
    throw new Error(payload.error ?? "Request failed.");
  }

  return payload;
}

function toast(message, type = "success") {
  state.toast = { message, type };
  renderToast();
  clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 3600);
}

function renderToast() {
  let toastNode = document.getElementById("toast-root");
  if (!toastNode) {
    toastNode = document.createElement("div");
    toastNode.id = "toast-root";
    document.body.appendChild(toastNode);
  }

  toastNode.innerHTML = state.toast
    ? `<div class="toast ${state.toast.type === "error" ? "is-error" : ""}">${escapeHtml(state.toast.message)}</div>`
    : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

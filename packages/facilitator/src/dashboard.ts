/**
 * Operator dashboard — single-page HTML app served at GET /v1/dashboard.
 *
 * No framework, no bundler. Tailwind CDN + vanilla JS.
 * Authentication: API key stored in sessionStorage after login.
 * All data is loaded from the facilitator's own REST API.
 */

export function renderDashboard(baseUrl: string): string {
  // JSON-island carries only the API base URL — no credentials.
  const apiBase = JSON.stringify(baseUrl.replace(/\/$/, ""))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>x490 Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen font-sans text-gray-900">

  <!-- Login screen -->
  <div id="screen-login" class="flex items-center justify-center min-h-screen">
    <div class="bg-white rounded-xl border border-gray-200 p-8 w-full max-w-sm">
      <h1 class="text-xl font-bold mb-1">x490 Dashboard</h1>
      <p class="text-sm text-gray-500 mb-6">Enter your operator API key to continue.</p>
      <label class="block text-sm font-medium text-gray-700 mb-1" for="login-key">API Key</label>
      <input
        id="login-key"
        type="password"
        placeholder="x490_live_..."
        class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <p id="login-error" class="hidden text-sm text-red-600 mb-3"></p>
      <button
        onclick="login()"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg text-sm font-medium"
      >Sign In</button>
    </div>
  </div>

  <!-- Main app -->
  <div id="screen-app" class="hidden">

    <!-- Header -->
    <header class="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div class="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
        <div class="flex items-center gap-6">
          <span class="font-bold text-gray-900">x490</span>
          <nav class="flex gap-1">
            <button onclick="showTab('overview')" id="tab-overview"
              class="tab-btn px-3 py-1.5 text-sm rounded-md font-medium">Overview</button>
            <button onclick="showTab('integrations')" id="tab-integrations"
              class="tab-btn px-3 py-1.5 text-sm rounded-md font-medium">Integrations</button>
            <button onclick="showTab('agreements')" id="tab-agreements"
              class="tab-btn px-3 py-1.5 text-sm rounded-md font-medium">Agreements</button>
          </nav>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm text-gray-500" id="tenant-name"></span>
          <button onclick="logout()"
            class="text-sm text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-1.5 rounded-md">Sign out</button>
        </div>
      </div>
    </header>

    <main class="max-w-6xl mx-auto px-4 sm:px-6 py-8">

      <!-- Overview tab -->
      <div id="panel-overview" class="hidden">
        <h2 class="text-lg font-semibold mb-6">Overview</h2>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Total Agreements</p>
            <p class="text-3xl font-bold" id="stat-agreements">—</p>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Active Integrations</p>
            <p class="text-3xl font-bold" id="stat-integrations">—</p>
          </div>
          <div class="bg-white rounded-xl border border-gray-200 p-5">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Templates</p>
            <p class="text-3xl font-bold" id="stat-templates">—</p>
          </div>
        </div>
        <h3 class="text-sm font-semibold text-gray-700 mb-3">Recent Agreements</h3>
        <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-100">
              <tr>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Contract ID</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Party</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Source</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Issued</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody id="agreements-table" class="divide-y divide-gray-50"></tbody>
          </table>
          <p id="agreements-empty" class="hidden text-sm text-gray-400 text-center py-8">No agreements yet.</p>
        </div>
      </div>

      <!-- Integrations tab -->
      <div id="panel-integrations" class="hidden">
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-lg font-semibold">Integrations</h2>
          <p class="text-sm text-gray-500">Connect your CLM platforms</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4" id="integration-cards"></div>
      </div>

      <!-- Agreements tab -->
      <div id="panel-agreements" class="hidden">
        <h2 class="text-lg font-semibold mb-6">Agreements</h2>
        <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-100">
              <tr>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Contract ID</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Party</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Template</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Source</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Issued</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Expires</th>
                <th class="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody id="all-agreements-table" class="divide-y divide-gray-50"></tbody>
          </table>
          <p id="all-agreements-empty" class="hidden text-sm text-gray-400 text-center py-8">No agreements yet.</p>
        </div>
      </div>

    </main>
  </div>

  <!-- Integration config modal -->
  <div id="modal-backdrop" class="hidden fixed inset-0 bg-black/30 z-20 flex items-center justify-center">
    <div class="bg-white rounded-xl border border-gray-200 p-6 w-full max-w-md mx-4">
      <h3 class="text-base font-semibold mb-4" id="modal-title">Configure Integration</h3>
      <div id="modal-fields" class="space-y-3 mb-4"></div>
      <p id="modal-error" class="hidden text-sm text-red-600 mb-3"></p>
      <div class="flex gap-2 justify-end">
        <button onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
        <button id="modal-save" class="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium">Save</button>
      </div>
    </div>
  </div>

  <script>
    const API = ${apiBase};
    let apiKey = '';
    let tenantId = '';

    // ── Auth ────────────────────────────────────────────────────────────────────

    async function login() {
      const key = document.getElementById('login-key').value.trim();
      if (!key) return;
      try {
        const res = await fetch(API + '/v1/me', { headers: { 'X-API-Key': key } });
        if (!res.ok) {
          document.getElementById('login-error').textContent = 'Invalid API key.';
          document.getElementById('login-error').classList.remove('hidden');
          return;
        }
        const { tenantId: tid, name } = await res.json();
        apiKey = key;
        tenantId = tid;
        sessionStorage.setItem('x490_key', key);
        sessionStorage.setItem('x490_tenant', tid);
        document.getElementById('tenant-name').textContent = name;
        document.getElementById('screen-login').classList.add('hidden');
        document.getElementById('screen-app').classList.remove('hidden');
        showTab('overview');
      } catch {
        document.getElementById('login-error').textContent = 'Network error.';
        document.getElementById('login-error').classList.remove('hidden');
      }
    }

    function logout() {
      sessionStorage.removeItem('x490_key');
      sessionStorage.removeItem('x490_tenant');
      apiKey = '';
      tenantId = '';
      document.getElementById('screen-app').classList.add('hidden');
      document.getElementById('screen-login').classList.remove('hidden');
    }

    // ── Tabs ────────────────────────────────────────────────────────────────────

    function showTab(name) {
      ['overview','integrations','agreements'].forEach(t => {
        document.getElementById('panel-' + t).classList.toggle('hidden', t !== name);
        const btn = document.getElementById('tab-' + t);
        btn.classList.toggle('bg-gray-100', t === name);
        btn.classList.toggle('text-gray-900', t === name);
        btn.classList.toggle('text-gray-500', t !== name);
      });
      if (name === 'overview') loadOverview();
      if (name === 'integrations') loadIntegrations();
      if (name === 'agreements') loadAllAgreements();
    }

    // ── API helpers ─────────────────────────────────────────────────────────────

    async function apiFetch(path, opts = {}) {
      return fetch(API + path, {
        ...opts,
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', ...opts.headers },
      });
    }

    function fmtDate(unix) {
      return unix ? new Date(unix * 1000).toLocaleDateString() : '—';
    }

    function sourceBadge(source) {
      const colors = { ironclad: 'bg-purple-100 text-purple-700', docusign: 'bg-blue-100 text-blue-700' };
      const color = source ? (colors[source] || 'bg-gray-100 text-gray-600') : 'bg-gray-100 text-gray-400';
      return \`<span class="px-2 py-0.5 rounded text-xs font-medium \${color}">\${source || 'direct'}</span>\`;
    }

    // ── Overview ────────────────────────────────────────────────────────────────

    async function loadOverview() {
      const [agrRes, intRes, tmplRes] = await Promise.all([
        apiFetch('/v1/agreements?limit=10'),
        apiFetch('/v1/integrations'),
        apiFetch('/v1/templates?limit=1'),
      ]);
      const { agreements = [] } = agrRes.ok ? await agrRes.json() : {};
      const { integrations = [] } = intRes.ok ? await intRes.json() : {};
      const { templates = [] } = tmplRes.ok ? await tmplRes.json() : {};

      document.getElementById('stat-agreements').textContent = agreements.length;
      document.getElementById('stat-integrations').textContent = integrations.length;
      document.getElementById('stat-templates').textContent = templates.length;

      const tbody = document.getElementById('agreements-table');
      const empty = document.getElementById('agreements-empty');
      tbody.innerHTML = '';
      if (agreements.length === 0) {
        empty.classList.remove('hidden');
      } else {
        empty.classList.add('hidden');
        agreements.slice(0, 5).forEach(a => {
          const tr = document.createElement('tr');
          tr.className = 'hover:bg-gray-50';
          tr.innerHTML = \`
            <td class="px-4 py-3 font-mono text-xs text-gray-500">\${a.contractId.slice(0,8)}…</td>
            <td class="px-4 py-3">\${esc(a.partyId ?? '—')}</td>
            <td class="px-4 py-3">\${sourceBadge(a.externalSource)}</td>
            <td class="px-4 py-3 text-gray-500">\${fmtDate(a.issuedAt)}</td>
            <td class="px-4 py-3">\${a.revokedAt
              ? '<span class="text-red-500 text-xs">Revoked</span>'
              : '<span class="text-green-600 text-xs">Active</span>'}</td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    // ── Integrations ────────────────────────────────────────────────────────────

    const INTEGRATION_DEFS = {
      ironclad: {
        name: 'Ironclad',
        description: 'Sync Ironclad workflows with x490 for counterparty review and negotiation.',
        fields: [
          { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Bearer token from Ironclad developer portal' },
          { key: 'baseUrl', label: 'Base URL (optional)', type: 'text', placeholder: 'https://ironcladapp.com/public/api/v1' },
        ],
        webhookPath: 'ironclad',
      },
      docusign: {
        name: 'DocuSign',
        description: 'Record completed DocuSign envelopes as x490 agreements automatically.',
        fields: [
          { key: 'accessToken', label: 'Access Token', type: 'password', placeholder: 'OAuth access token' },
          { key: 'accountId', label: 'Account ID', type: 'text', placeholder: 'Your DocuSign account UUID' },
          { key: 'baseUrl', label: 'Base URL (optional)', type: 'text', placeholder: 'https://na4.docusign.net/restapi/v2.1' },
        ],
        webhookPath: 'docusign',
      },
    };

    async function loadIntegrations() {
      const res = await apiFetch('/v1/integrations');
      const { integrations = [] } = res.ok ? await res.json() : {};
      const configuredBySource = Object.fromEntries(integrations.map(i => [i.source, i]));

      const container = document.getElementById('integration-cards');
      container.innerHTML = '';

      Object.entries(INTEGRATION_DEFS).forEach(([source, def]) => {
        const configured = configuredBySource[source];
        const webhookUrl = API + '/v1/' + tenantId + '/integrations/' + def.webhookPath + '/webhook';
        const card = document.createElement('div');
        card.className = 'bg-white rounded-xl border border-gray-200 p-6';
        card.innerHTML = \`
          <div class="flex items-start justify-between mb-3">
            <div>
              <h3 class="font-semibold text-gray-900">\${def.name}</h3>
              <p class="text-sm text-gray-500 mt-0.5">\${def.description}</p>
            </div>
            <span class="ml-3 px-2 py-0.5 rounded-full text-xs font-medium \${configured
              ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">
              \${configured ? 'Connected' : 'Not configured'}
            </span>
          </div>
          \${configured ? \`
          <div class="bg-gray-50 rounded-lg p-3 mb-3 text-xs">
            <p class="text-gray-500 mb-1 font-medium">Webhook URL (paste into \${def.name})</p>
            <div class="flex items-center gap-2">
              <code class="text-gray-700 break-all flex-1">\${webhookUrl}</code>
              <button onclick="copyText('\${webhookUrl}')" class="text-blue-600 hover:text-blue-800 font-medium shrink-0">Copy</button>
            </div>
          </div>
          \` : ''}
          <div class="flex gap-2">
            <button onclick="openModal('\${source}')" class="flex-1 text-sm border border-gray-200 text-gray-700 hover:bg-gray-50 py-2 rounded-lg font-medium">
              \${configured ? 'Update credentials' : 'Configure'}
            </button>
            \${configured ? \`<button onclick="removeIntegration('\${source}')" class="text-sm text-red-600 hover:text-red-800 border border-red-200 px-3 py-2 rounded-lg">Remove</button>\` : ''}
          </div>
        \`;
        container.appendChild(card);
      });
    }

    let modalSource = '';

    function openModal(source) {
      modalSource = source;
      const def = INTEGRATION_DEFS[source];
      document.getElementById('modal-title').textContent = 'Configure ' + def.name;
      document.getElementById('modal-error').classList.add('hidden');
      const fields = document.getElementById('modal-fields');
      fields.innerHTML = '';
      [
        { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', placeholder: 'Signing secret from ' + def.name },
        ...def.fields,
      ].forEach(f => {
        fields.innerHTML += \`
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">\${f.label}</label>
            <input id="modal-field-\${f.key}" type="\${f.type}" placeholder="\${f.placeholder}"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        \`;
      });
      document.getElementById('modal-save').onclick = saveIntegration;
      document.getElementById('modal-backdrop').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('modal-backdrop').classList.add('hidden');
      modalSource = '';
    }

    async function saveIntegration() {
      const def = INTEGRATION_DEFS[modalSource];
      const webhookSecret = document.getElementById('modal-field-webhookSecret')?.value?.trim() ?? '';
      const credentials = {};
      def.fields.forEach(f => {
        const val = document.getElementById('modal-field-' + f.key)?.value?.trim() ?? '';
        if (val) credentials[f.key] = val;
      });
      if (!webhookSecret) {
        document.getElementById('modal-error').textContent = 'Webhook secret is required.';
        document.getElementById('modal-error').classList.remove('hidden');
        return;
      }
      document.getElementById('modal-save').setAttribute('disabled', 'true');
      try {
        const res = await apiFetch('/v1/integrations/' + modalSource, {
          method: 'PUT',
          body: JSON.stringify({ credentials, webhookSecret }),
        });
        if (!res.ok) {
          const { error } = await res.json();
          document.getElementById('modal-error').textContent = error ?? 'Save failed.';
          document.getElementById('modal-error').classList.remove('hidden');
          return;
        }
        closeModal();
        loadIntegrations();
      } finally {
        document.getElementById('modal-save').removeAttribute('disabled');
      }
    }

    async function removeIntegration(source) {
      if (!confirm('Remove ' + INTEGRATION_DEFS[source].name + ' integration?')) return;
      await apiFetch('/v1/integrations/' + source, { method: 'DELETE' });
      loadIntegrations();
    }

    // ── All agreements ──────────────────────────────────────────────────────────

    async function loadAllAgreements() {
      const res = await apiFetch('/v1/agreements?limit=50');
      const { agreements = [] } = res.ok ? await res.json() : {};
      const tbody = document.getElementById('all-agreements-table');
      const empty = document.getElementById('all-agreements-empty');
      tbody.innerHTML = '';
      if (agreements.length === 0) {
        empty.classList.remove('hidden');
      } else {
        empty.classList.add('hidden');
        agreements.forEach(a => {
          const tr = document.createElement('tr');
          tr.className = 'hover:bg-gray-50';
          tr.innerHTML = \`
            <td class="px-4 py-3 font-mono text-xs text-gray-500">\${a.contractId.slice(0,8)}…</td>
            <td class="px-4 py-3 text-sm">\${esc(a.partyId ?? '—')}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-400">\${a.templateHash?.slice(0,8) ?? '—'}…</td>
            <td class="px-4 py-3">\${sourceBadge(a.externalSource)}</td>
            <td class="px-4 py-3 text-gray-500 text-xs">\${fmtDate(a.issuedAt)}</td>
            <td class="px-4 py-3 text-gray-500 text-xs">\${fmtDate(a.expiresAt)}</td>
            <td class="px-4 py-3">\${a.revokedAt
              ? '<span class="text-red-500 text-xs">Revoked</span>'
              : '<span class="text-green-600 text-xs">Active</span>'}</td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    // ── Utilities ───────────────────────────────────────────────────────────────

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function copyText(text) {
      navigator.clipboard.writeText(text).catch(() => {});
    }

    // ── Boot ────────────────────────────────────────────────────────────────────

    (function boot() {
      const storedKey = sessionStorage.getItem('x490_key');
      const storedTenant = sessionStorage.getItem('x490_tenant');
      if (storedKey && storedTenant) {
        apiKey = storedKey;
        tenantId = storedTenant;
        // Re-validate the key on boot
        fetch(API + '/v1/me', { headers: { 'X-API-Key': storedKey } })
          .then(r => r.ok ? r.json() : Promise.reject())
          .then(({ name }) => {
            document.getElementById('tenant-name').textContent = name;
            document.getElementById('screen-login').classList.add('hidden');
            document.getElementById('screen-app').classList.remove('hidden');
            showTab('overview');
          })
          .catch(logout);
      }
    })();

    // Allow Enter key on login screen
    document.getElementById('login-key').addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;
}

/**
 * Counterparty contract review UI.
 *
 * Self-contained HTML page served at GET /v1/:tenantId/review/:templateHash.
 * No framework, no bundler — just Tailwind CDN + marked.js CDN + vanilla JS.
 * Counterparties land here via a link in an email or from a CLM like Ironclad.
 */

import type { Tenant, RegisteredTemplate, RequirementsConfig } from "./types.js";
import type { NegotiableField } from "@x490/protocol";

// Inline clause extractor — avoids pulling in @x490/agents as a dependency.
const CLAUSE_RE = /<!-- clause:([\w-]+) -->([\s\S]*?)<!-- \/clause:\1 -->/g;

function extractClauses(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const m of content.matchAll(CLAUSE_RE)) {
    if (m[1] !== undefined && m[2] !== undefined) result[m[1]] = m[2].trim();
  }
  return result;
}

export interface ReviewPageOptions {
  tenant: Tenant;
  tmpl: RegisteredTemplate;
  reqConfig: RequirementsConfig | null;
  baseUrl: string;
  /**
   * After acceptance, redirect to this URL with ?token=&contractId=&state=
   * appended. Enables the OAuth-style redirect flow so any web app can
   * integrate x490 without the user ever leaving their native context.
   * Must be HTTPS (or http://localhost for development).
   */
  redirectUri?: string;
  /**
   * Opaque value passed back untouched on redirect / postMessage.
   * Use to correlate the acceptance with the initiating request in your app.
   */
  state?: string;
  /**
   * When true, the page fires window.parent.postMessage after acceptance
   * instead of redirecting. Use when embedding the review page in an iframe
   * inside your own application.
   */
  embedded?: boolean;
}

export function renderReviewPage(opts: ReviewPageOptions): string {
  const { tenant, tmpl, reqConfig, baseUrl, redirectUri, state, embedded } = opts;

  const title = tmpl.meta.title ?? "Contract Review";
  const description = tmpl.meta.description ?? "";
  const requiredPartyFields = reqConfig?.requiredPartyFields ?? ["name", "email"];
  const negotiableFields: NegotiableField[] = reqConfig?.negotiableFields ?? [];
  const clauses = extractClauses(tmpl.content);

  // Enrich negotiable fields with current clause values where available.
  const enrichedFields = negotiableFields.map((f) => ({
    ...f,
    currentValue: Object.prototype.hasOwnProperty.call(clauses, f.field)
      ? (clauses[f.field] ?? "")
      : "",
  }));

  const acceptEndpoint = `${baseUrl}/v1/${tenant.tenantId}/accept`;

  // JSON island — escape < > & so a malicious string can't break the script tag.
  const pageData = JSON.stringify({
    tenantName: tenant.name,
    tenantId: tenant.tenantId,
    templateHash: tmpl.hash,
    title,
    content: tmpl.content,
    requiredPartyFields,
    negotiableFields: enrichedFields,
    acceptEndpoint,
    ...(redirectUri ? { redirectUri } : {}),
    ...(state ? { state } : {}),
    ...(embedded ? { embedded: true } : {}),
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  const partyFields = requiredPartyFields
    .map(
      (f) => `
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1" for="party-${esc(f)}">
          ${esc(capitalise(f))} <span class="text-red-500">*</span>
        </label>
        <input
          id="party-${esc(f)}"
          type="${f === "email" ? "email" : "text"}"
          placeholder="${esc(capitalise(f))}"
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>`,
    )
    .join("");

  const negotiablePanel =
    enrichedFields.length === 0
      ? ""
      : `
      <div class="border-t border-gray-100 pt-4 mb-4">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Propose Changes</p>
        <div class="space-y-3">
          ${enrichedFields
            .map(
              (f) => `
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1" for="neg-${esc(f.field)}">
                ${esc(f.description)}
              </label>
              ${
                f.allowedValues && f.allowedValues.length > 0
                  ? `<select id="neg-${esc(f.field)}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— keep current —</option>
                  ${f.allowedValues.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}
                </select>`
                  : `<input
                  id="neg-${esc(f.field)}"
                  type="text"
                  placeholder="${esc(f.currentValue !== "" ? f.currentValue : "Propose a value")}"
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />`
              }
            </div>`,
            )
            .join("")}
        </div>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)} — x490</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"></script>
  <style>
    .prose h1{font-size:1.5rem;font-weight:700;margin-bottom:.75rem;color:#111827}
    .prose h2{font-size:1.125rem;font-weight:600;margin:1.25rem 0 .5rem;color:#1f2937}
    .prose h3{font-size:1rem;font-weight:600;margin:1rem 0 .375rem;color:#1f2937}
    .prose p{margin-bottom:.75rem;color:#374151;line-height:1.625}
    .prose ul,.prose ol{margin:.5rem 0 .75rem 1.25rem;color:#374151}
    .prose li{margin-bottom:.25rem}
    .prose strong{font-weight:600;color:#111827}
    .prose blockquote{border-left:3px solid #e5e7eb;padding-left:.75rem;color:#6b7280;font-style:italic}
    .clause-highlight{background:#fef9c3;border-bottom:2px solid #fbbf24;padding:0 2px;border-radius:2px;cursor:help}
  </style>
</head>
<body class="bg-gray-50 min-h-screen font-sans">

  <!-- Header -->
  <header class="bg-white border-b border-gray-200">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
      <div class="flex items-center gap-2 text-sm">
        <span class="font-semibold text-gray-900">x490</span>
        <span class="text-gray-300">/</span>
        <span class="text-gray-500">Contract Review</span>
      </div>
      <span class="text-sm text-gray-500">
        Sent by <strong class="text-gray-800">${esc(tenant.name)}</strong>
      </span>
    </div>
  </header>

  <!-- Main -->
  <main class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    ${description ? `<p class="text-sm text-gray-500 mb-4">${esc(description)}</p>` : ""}
    <div class="flex flex-col lg:flex-row gap-8 items-start">

      <!-- Contract content -->
      <div class="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 p-8">
        <div id="contract-content" class="prose max-w-none"></div>
      </div>

      <!-- Action panel -->
      <div class="w-full lg:w-80 flex-shrink-0">
        <div class="bg-white rounded-xl border border-gray-200 p-6 lg:sticky lg:top-6">

          <!-- Review state -->
          <div id="panel-review">
            <h2 class="text-base font-semibold text-gray-900 mb-4">Your Information</h2>
            <div class="space-y-3 mb-4">
              ${partyFields}
            </div>
            ${negotiablePanel}
            <button
              id="btn-accept"
              onclick="submitAccept()"
              class="w-full bg-green-600 hover:bg-green-700 text-white py-2.5 px-4 rounded-lg text-sm font-medium transition-colors"
            >Accept Contract</button>
            ${
              enrichedFields.length > 0
                ? `<button
              id="btn-negotiate"
              onclick="submitNegotiate()"
              class="mt-2 w-full bg-white hover:bg-gray-50 text-blue-600 border border-blue-300 py-2.5 px-4 rounded-lg text-sm font-medium transition-colors"
            >Propose Changes</button>`
                : ""
            }
            <p id="submitting" class="hidden text-center text-sm text-gray-500 mt-3">Submitting…</p>
          </div>

          <!-- Success state -->
          <div id="panel-success" class="hidden text-center">
            <div class="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <h2 class="text-base font-semibold text-gray-900">Agreement Accepted</h2>
            <p class="text-sm text-gray-500 mt-1 mb-4">Your contract has been recorded on the x490 protocol.</p>
            <div id="success-details" class="bg-gray-50 rounded-lg p-3 text-left font-mono text-xs text-gray-600 break-all"></div>
          </div>

          <!-- Counter-offer state -->
          <div id="panel-counter" class="hidden">
            <div class="flex items-center gap-2 mb-3">
              <div class="w-2 h-2 rounded-full bg-amber-400"></div>
              <h2 class="text-base font-semibold text-gray-900">Counter Offer</h2>
            </div>
            <p class="text-sm text-gray-500 mb-3">The issuer has proposed different terms. Review and accept or decline.</p>
            <div id="counter-details" class="space-y-2 mb-4"></div>
            <button
              onclick="submitAccept(true)"
              class="w-full bg-green-600 hover:bg-green-700 text-white py-2.5 px-4 rounded-lg text-sm font-medium transition-colors"
            >Accept Counter Offer</button>
            <button
              onclick="showPanel('review')"
              class="mt-2 w-full text-sm text-gray-500 hover:text-gray-700 py-2"
            >Decline</button>
          </div>

          <!-- Error state -->
          <div id="panel-error" class="hidden">
            <div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <p class="text-sm text-red-700" id="error-message">An error occurred.</p>
            </div>
            <button
              onclick="showPanel('review')"
              class="w-full border border-gray-300 text-gray-700 py-2 px-4 rounded-lg text-sm hover:bg-gray-50"
            >Try Again</button>
          </div>

        </div>
      </div>

    </div>
  </main>

  <footer class="text-center py-8 text-xs text-gray-400">
    Secured by
    <a href="https://github.com/peterhunn/peterhunn" class="underline hover:text-gray-600">x490 Protocol</a>
    · Template hash: <span class="font-mono">${tmpl.hash.slice(0, 12)}…</span>
  </footer>

  <script>
    const DATA = ${pageData};

    // ── Render contract ─────────────────────────────────────────────────────────

    (function renderContract() {
      // Strip clause markers, optionally highlight the clause text.
      const rendered = DATA.content.replace(
        new RegExp('<!-- clause:([\\w-]+) -->([\\s\\S]*?)<!-- /clause:\\1 -->', 'g'),
        (_match, id, text) => {
          const isNegotiable = DATA.negotiableFields.some(f => f.field === id);
          const trimmed = text.trim();
          return isNegotiable
            ? \`<span class="clause-highlight" title="Negotiable: \${id}">\${trimmed}</span>\`
            : trimmed;
        }
      );
      document.getElementById('contract-content').innerHTML = marked.parse(rendered);
    })();

    // ── Panel state ─────────────────────────────────────────────────────────────

    let counterOfferData = null;

    function showPanel(name) {
      ['review','success','counter','error'].forEach(p => {
        document.getElementById('panel-' + p).classList.toggle('hidden', p !== name);
      });
    }

    // ── Form helpers ────────────────────────────────────────────────────────────

    function getPartyData() {
      return Object.fromEntries(
        DATA.requiredPartyFields.map(f => [f, document.getElementById('party-' + f)?.value?.trim() ?? ''])
      );
    }

    function getNegotiationTerms() {
      const terms = {};
      DATA.negotiableFields.forEach(f => {
        const el = document.getElementById('neg-' + f.field);
        if (el && el.value.trim() !== '') terms[f.field] = el.value.trim();
      });
      return Object.keys(terms).length > 0 ? terms : undefined;
    }

    function validate(partyData) {
      for (const field of DATA.requiredPartyFields) {
        if (!partyData[field]) {
          document.getElementById('panel-error').classList.remove('hidden');
          document.getElementById('error-message').textContent = field + ' is required.';
          showPanel('error');
          return false;
        }
      }
      return true;
    }

    // ── Submit ──────────────────────────────────────────────────────────────────

    async function submit(negotiationTerms) {
      const partyData = counterOfferData
        ? Object.fromEntries(DATA.requiredPartyFields.map(f => [f, document.getElementById('party-' + f)?.value?.trim() ?? '']))
        : getPartyData();

      if (!validate(partyData)) return;

      document.getElementById('btn-accept')?.setAttribute('disabled', 'true');
      document.getElementById('btn-negotiate')?.setAttribute('disabled', 'true');
      document.getElementById('submitting')?.classList.remove('hidden');

      const body = {
        templateId: 'x490:' + DATA.templateHash.slice(0, 8),
        templateHash: DATA.templateHash,
        partyData,
        ...(negotiationTerms ? { negotiationTerms } : {}),
      };

      try {
        const res = await fetch(DATA.acceptEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();

        if (json.status === 'accepted') {
          if (DATA.redirectUri) {
            const params = new URLSearchParams();
            params.set('token', json.token ?? '');
            params.set('contractId', json.contractId ?? '');
            if (DATA.state) params.set('state', DATA.state);
            const sep = DATA.redirectUri.includes('?') ? '&' : '?';
            location.href = DATA.redirectUri + sep + params.toString();
            return;
          }
          if (DATA.embedded) {
            window.parent.postMessage({
              type: 'x490:accepted',
              token: json.token ?? '',
              contractId: json.contractId ?? '',
              state: DATA.state ?? null,
            }, '*');
          }
          document.getElementById('success-details').innerHTML =
            'Contract ID<br><span class="text-gray-800">' + (json.contractId ?? '') + '</span>';
          showPanel('success');

        } else if (json.status === 'counter_offer' && json.counterOffer) {
          counterOfferData = json.counterOffer;
          const el = document.getElementById('counter-details');
          el.innerHTML = '';
          const shown = ['expiresIn','description','negotiableFields'];
          Object.entries(json.counterOffer)
            .filter(([k]) => shown.includes(k))
            .forEach(([k, v]) => {
              const div = document.createElement('div');
              div.className = 'flex justify-between text-sm p-2 bg-amber-50 rounded';
              div.innerHTML = '<span class="text-gray-600">' + k + '</span><span class="font-medium">' + JSON.stringify(v) + '</span>';
              el.appendChild(div);
            });
          showPanel('counter');

        } else {
          document.getElementById('error-message').textContent = json.error ?? 'The server returned an unexpected response.';
          showPanel('error');
        }
      } catch {
        document.getElementById('error-message').textContent = 'Network error. Please check your connection and try again.';
        showPanel('error');
      } finally {
        document.getElementById('btn-accept')?.removeAttribute('disabled');
        document.getElementById('btn-negotiate')?.removeAttribute('disabled');
        document.getElementById('submitting')?.classList.add('hidden');
      }
    }

    function submitAccept(isCounterAccept) { submit(undefined); }
    function submitNegotiate() { submit(getNegotiationTerms()); }
  </script>
</body>
</html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/([A-Z])/g, " $1");
}

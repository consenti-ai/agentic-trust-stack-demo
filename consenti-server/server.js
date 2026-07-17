// Real Consenti protocol server: discovery, 409-gated actions, and commit.
//
// LIVE MODE: commit generates a real PDF and POSTs it directly to Blocksee's
// REST API (api.blocksee.co/api/v1/agreements, multipart file upload) using
// the same API key configured for the blocksee MCP connector. No relay step
// needed — the real agreement is created synchronously within the commit
// request and returned in the response.
//
// Contract for POST /api/v1/agreements was discovered by trial (no public
// docs): multipart fields `file` (PDF), `title`, `parties` (JSON array),
// `fields` (JSON array of {type, label, signer_index, x, y, page} — x/y are
// percentages of page width/height, top-left origin).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { renderAgreementPdf } = require('./pdf');

const PORT = process.env.PORT || 4090;
const BLOCKSEE_API_URL = 'https://api.blocksee.co/api/v1/agreements';

// PayPangea's collections endpoint has been returning a routing-level 404
// all along (confirmed: even GET / on api.paypangea.com returns the same
// body — the path itself is wrong/outdated, not a validation issue). This
// call is still real and will genuinely attempt payment once both parties
// sign; it's expected to fail until PayPangea's correct endpoint is found.
const PAYPANGEA_API_URL = 'https://api.paypangea.com/pay/request-pay-sdk';
const PAYPANGEA_BASE_URL = 'https://paypangea.com';
const USDC_ADDRESSES = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  polygon: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};

// How often to poll Blocksee for signature completion on watched agreements.
// Blocksee has no webhook/callback mechanism (confirmed by probing every
// plausible REST path and the full agreement object schema — no such field
// exists), so polling is the only option.
const PAYMENT_POLL_INTERVAL_MS = 60 * 1000;

// Certisyn's own SecretVM domain, per Alex @ SCRT Labs (2026-07-15). Like our
// own domain, this is ephemeral — SecretVM has no in-place update, so it'll
// change whenever Certisyn redeploys. No docker-files hash needed here: their
// compose bakes secrets via `environment:` directly rather than an
// Additional Files tar, confirmed via a clean `secretvm-verify` pass with no
// extra flags.
const CERTISYN_DOMAIN = 'plum-cicada.vm.scrtlabs.com';

function loadBlockseeApiKey() {
  if (process.env.BLOCKSEE_API_KEY) return process.env.BLOCKSEE_API_KEY;
  try {
    const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const args = cfg.mcpServers?.blocksee?.args || [];
    const header = args.find((a) => a.startsWith('X-API-Key:'));
    if (header) return header.split('X-API-Key: ')[1].trim();
  } catch {
    // fall through
  }
  return null;
}

const BLOCKSEE_API_KEY = loadBlockseeApiKey();

function loadPayPangeaApiKey() {
  if (process.env.PAYPANGEA_API_KEY) return process.env.PAYPANGEA_API_KEY;
  try {
    const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const key = cfg.mcpServers?.['blocksee-payments']?.env?.PAYPANGEA_API_KEY;
    if (key) return key;
  } catch {
    // fall through
  }
  return null;
}

const PAYPANGEA_API_KEY = loadPayPangeaApiKey();

const OWNER_PARTY = { name: 'Blocksee (FHBK Technologies Inc)', email: 'forsteric@gmail.com', is_owner: true };

const CLAUSES = [
  { heading: 'Subscription', text: 'Acme Corp subscribes to Blocksee Professional API access at $60 USD per month, billed monthly, payable in USDC on Polygon.' },
  { heading: 'Usage Rights', text: 'Subscriber is granted 10,000 API calls per month, covering create_agreement, seal_document, and verify_hash endpoints. Rate limits apply per the API documentation.' },
  { heading: 'Agent Authorization', text: 'Subscriber authorizes an automated agent to form this agreement on its behalf under UETA Section 14 and ESIGN. Agent-formed commitments are binding on the subscriber.' },
  { heading: 'Terms Before Transactions', text: "All API transactions executed by authorized agents are subject to Blocksee's Terms of Service." },
  { heading: 'Governing Law', text: 'This agreement is governed by the laws of the State of California.' },
];
const RECITAL = "This Agreement sets out the terms under which Acme Corp accesses Blocksee's Professional API, and must be accepted before any subscription or API-access transaction proceeds.";
const TITLE = 'Consenti Terms of Service v4';

const TERMS_TEXT = TITLE + '\n\n' + RECITAL + '\n\n' + CLAUSES.map((c, i) => `${i + 1}. ${c.heading}. ${c.text}`).join('\n\n');
const AGREEMENT_HASH = 'sha256:' + crypto.createHash('sha256').update(TERMS_TEXT).digest('hex');
const GATED_ACTIONS = ['subscription_purchase', 'api_access'];

// email -> { agreement_hash, committed_at }
const committedParties = new Map();

// agreement_id -> { agreement_id, uuid, party, watching_since, last_checked,
//                    status, payment_attempted, payment_result }
// In-memory only — doesn't survive a server restart, same limitation as
// committedParties above. Fine for a demo; a real deployment would persist
// this.
const watchedAgreements = new Map();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(payload);
}

function baseUrl(req) {
  return `http://${req.headers.host}`;
}

function agreementRequiredBody(req, action) {
  return {
    error: 'agreement_required',
    protocol: 'consenti/discovery/v0.1',
    agreement_ref: `${baseUrl(req)}/.well-known/agreements/tos-v4.json`,
    agreement_hash: AGREEMENT_HASH,
    commit_endpoint: `${baseUrl(req)}/api/agreements/commit`,
    applies_to: {
      actions: GATED_ACTIONS,
      required: true,
      negotiable: false,
    },
    ...(action ? { attempted_action: action } : {}),
  };
}

async function createRealBlockseeAgreement(counterparty) {
  const parties = [OWNER_PARTY, { name: counterparty.name, email: counterparty.email, is_owner: false }];
  const { buffer, fields } = await renderAgreementPdf({
    title: 'Blocksee Professional API Access — Acme Corp',
    recital: RECITAL,
    clauses: CLAUSES,
    parties,
  });

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'agreement.pdf');
  form.append('title', 'Blocksee Professional API Access — Acme Corp');
  form.append('parties', JSON.stringify(parties));
  form.append('fields', JSON.stringify(fields));
  form.append('priority', 'HIGH');
  form.append('due_date', dueDate);

  const response = await fetch(BLOCKSEE_API_URL, {
    method: 'POST',
    headers: { 'X-API-Key': BLOCKSEE_API_KEY },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || JSON.stringify(data));
  }
  return data;
}

// Real (currently broken) PayPangea payment call — see PAYPANGEA_API_URL
// comment above. Mirrors the request shape from
// /Users/ericforst/blocksee-payments-mcp/index.js's create_subscription_payment.
async function attemptPayPangeaPayment(agreement) {
  if (!PAYPANGEA_API_KEY) {
    return { attempted: false, success: false, error: 'PAYPANGEA_API_KEY not configured' };
  }
  const body = {
    amount: '60',
    token: 'USDC',
    tokenaddress: USDC_ADDRESSES.polygon,
    chain: 'polygon',
    title: 'Blocksee Pro — Monthly Subscription',
    text: 'Full platform access — zero-custody signing, Proof of Understanding, and verification.',
    merchantid: String(agreement.id),
  };
  try {
    const response = await fetch(PAYPANGEA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYPANGEA_API_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code === 400) {
      return { attempted: true, success: false, error: data.message || JSON.stringify(data) };
    }
    return { attempted: true, success: true, payment_url: `${PAYPANGEA_BASE_URL}?tkn=${data.tkn}` };
  } catch (err) {
    return { attempted: true, success: false, error: err.message };
  }
}

// Polls Blocksee for every agreement we're watching (Blocksee has no
// webhook/callback mechanism — confirmed by probing every plausible REST
// path and the full agreement object schema, neither shows any such
// field). Once both parties have signed, triggers the real PayPangea
// payment call exactly once per agreement.
async function checkAndTriggerPayments() {
  for (const [id, entry] of watchedAgreements) {
    if (entry.payment_attempted) continue;
    try {
      const res = await fetch(`${BLOCKSEE_API_URL}/${id}`, { headers: { 'X-API-Key': BLOCKSEE_API_KEY } });
      const agreement = await res.json();
      entry.last_checked = new Date().toISOString();
      entry.status = agreement.status;
      const allSigned = Array.isArray(agreement.parties) && agreement.parties.length > 0 && agreement.parties.every((p) => p.signed);
      if (allSigned) {
        console.log(`Agreement ${id} fully signed by all parties — triggering PayPangea payment.`);
        entry.payment_result = await attemptPayPangeaPayment(agreement);
        entry.payment_attempted = true;
      }
    } catch (err) {
      entry.last_error = err.message;
    }
  }
}

// Real Layer 1 TEE attestation — checks THIS running deployment against
// Secret Network's own attestation service. Fails gracefully (available:
// false) when not actually running on a SecretVM, e.g. during local dev.
async function checkOwnAttestation(host) {
  const { checkSecretVm } = await import('secretvm-verify');
  // No dockerFilesSha256 needed — the new deployment pattern (matching
  // Certisyn's own working compose) uses a top-level `configs:` block
  // instead of a separate Additional Files tar, so there's no extra
  // artifact contributing to the workload measurement to account for.
  const result = await checkSecretVm(host);
  return {
    available: true,
    valid: result.valid,
    checks: result.checks,
    platform: result.report?.cpu_type,
    mr_td: result.report?.cpu?.mr_td,
    workload: result.report?.workload,
    tls_fingerprint: result.report?.tls_fingerprint,
    errors: result.errors,
  };
}

// Real Layer 3 TEE attestation — checks Certisyn's own SecretVM deployment,
// independent of anything they build to interact with our API.
async function checkCertisynAttestation() {
  const { checkSecretVm } = await import('secretvm-verify');
  const result = await checkSecretVm(CERTISYN_DOMAIN);
  return {
    available: true,
    valid: result.valid,
    checks: result.checks,
    platform: result.report?.cpu_type,
    mr_td: result.report?.cpu?.mr_td,
    workload: result.report?.workload,
    tls_fingerprint: result.report?.tls_fingerprint || result.report?.tls_certificate_fingerprint,
    errors: result.errors,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, baseUrl(req));

  // Real TEE attestation check for this exact deployment (Layer 1).
  if (req.method === 'GET' && url.pathname === '/api/attestation') {
    try {
      const result = await checkOwnAttestation(req.headers.host);
      return send(res, 200, result);
    } catch (err) {
      return send(res, 200, { available: false, reason: err.message });
    }
  }

  // Real TEE attestation check for Certisyn's own deployment (Layer 3).
  if (req.method === 'GET' && url.pathname === '/api/attestation/certisyn') {
    try {
      const result = await checkCertisynAttestation();
      return send(res, 200, result);
    } catch (err) {
      return send(res, 200, { available: false, reason: err.message });
    }
  }

  // Discovery doc — always 200, describes what agreement is required.
  if (req.method === 'GET' && url.pathname === '/.well-known/agreements.json') {
    return send(res, 200, agreementRequiredBody(req));
  }

  // The actual terms content, real hash computed from real text above.
  if (req.method === 'GET' && url.pathname === '/.well-known/agreements/tos-v4.json') {
    return send(res, 200, {
      protocol: 'consenti/discovery/v0.1',
      agreement_hash: AGREEMENT_HASH,
      title: TITLE,
      body: TERMS_TEXT,
    });
  }

  // Commit endpoint — validates the hash, unblocks the party for the
  // Consenti gate, and synchronously creates the real Blocksee agreement.
  if (req.method === 'POST' && url.pathname === '/api/agreements/commit') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: 'invalid_json' });
    }

    const { agreement_hash, party } = body;
    if (!party || !party.email) {
      return send(res, 400, { error: 'missing_party', detail: 'party.email is required' });
    }
    if (agreement_hash !== AGREEMENT_HASH) {
      return send(res, 409, {
        error: 'stale_agreement_hash',
        detail: 'The agreement_hash you committed to does not match the current terms.',
        current_agreement_hash: AGREEMENT_HASH,
      });
    }
    if (!BLOCKSEE_API_KEY) {
      return send(res, 500, {
        error: 'blocksee_api_key_missing',
        detail: 'Could not find a Blocksee API key (checked BLOCKSEE_API_KEY env var and claude_desktop_config.json).',
      });
    }

    const committed_at = new Date().toISOString();
    committedParties.set(party.email, { agreement_hash, committed_at });

    let blockseeAgreement;
    try {
      blockseeAgreement = await createRealBlockseeAgreement(party);
    } catch (err) {
      return send(res, 502, { error: 'blocksee_agreement_creation_failed', detail: err.message });
    }

    watchedAgreements.set(blockseeAgreement.id, {
      agreement_id: blockseeAgreement.id,
      uuid: blockseeAgreement.uuid,
      party,
      watching_since: committed_at,
      last_checked: null,
      status: blockseeAgreement.status,
      payment_attempted: false,
      payment_result: null,
    });

    return send(res, 201, {
      status: 'created',
      agreement_hash,
      party,
      committed_at,
      blocksee_agreement: blockseeAgreement,
    });
  }

  // Observability into the payment-watch poller — which agreements are
  // being watched, their last-known signature status, and whether/how
  // payment was attempted once fully signed.
  if (req.method === 'GET' && url.pathname === '/api/payments/status') {
    return send(res, 200, { watched: Array.from(watchedAgreements.values()) });
  }

  // Manually trigger an immediate poll instead of waiting for the next
  // scheduled interval — useful for testing/demoing without a 60s wait.
  if (req.method === 'POST' && url.pathname === '/api/payments/poll-now') {
    await checkAndTriggerPayments();
    return send(res, 200, { watched: Array.from(watchedAgreements.values()) });
  }

  // Gated demo actions — require prior commitment by the calling party.
  if (req.method === 'POST' && (url.pathname === '/api/subscribe' || url.pathname === '/api/access')) {
    const action = url.pathname === '/api/subscribe' ? 'subscription_purchase' : 'api_access';
    const partyEmail = req.headers['x-party-email'];

    if (!partyEmail || !committedParties.has(partyEmail)) {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(agreementRequiredBody(req, action), null, 2));
    }

    const commitment = committedParties.get(partyEmail);
    if (commitment.agreement_hash !== AGREEMENT_HASH) {
      res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(agreementRequiredBody(req, action), null, 2));
    }

    return send(res, 200, {
      status: 'allowed',
      action,
      party: partyEmail,
      committed_at: commitment.committed_at,
    });
  }

  // Serve the demo UI same-origin so its fetch() calls need no CORS dance.
  if (req.method === 'GET' && url.pathname === '/demo.html') {
    const html = fs.readFileSync(path.join(__dirname, '..', 'demo.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      service: 'consenti-demo-server',
      mode: BLOCKSEE_API_KEY
        ? 'LIVE — commit creates a real Blocksee agreement synchronously via the REST API'
        : 'LIVE (misconfigured) — no Blocksee API key found, commit will fail',
      routes: [
        'GET  /.well-known/agreements.json',
        'GET  /.well-known/agreements/tos-v4.json',
        'POST /api/agreements/commit                 body: { agreement_hash, party: { name, email } } — creates a real Blocksee agreement',
        'POST /api/subscribe | /api/access            header: X-Party-Email  (409 until committed)',
        'GET  /api/attestation | /api/attestation/certisyn   real TEE attestation, own + Certisyn',
        'GET  /api/payments/status                    watched agreements + payment-trigger state',
        'POST /api/payments/poll-now                  force an immediate poll instead of waiting',
      ],
      agreement_hash: AGREEMENT_HASH,
      payment_polling: PAYPANGEA_API_KEY
        ? `every ${PAYMENT_POLL_INTERVAL_MS / 1000}s — PAYPANGEA_API_KEY loaded`
        : `every ${PAYMENT_POLL_INTERVAL_MS / 1000}s — WARNING: no PAYPANGEA_API_KEY found, payment attempts will fail`,
    });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Consenti demo server listening on http://localhost:${PORT}`);
  console.log(`agreement_hash: ${AGREEMENT_HASH}`);
  console.log(BLOCKSEE_API_KEY ? 'Blocksee API key loaded.' : 'WARNING: no Blocksee API key found — commit will fail.');
  console.log(PAYPANGEA_API_KEY ? 'PayPangea API key loaded.' : 'WARNING: no PayPangea API key found — payment attempts will fail.');
  console.log(`Payment-watch poller running every ${PAYMENT_POLL_INTERVAL_MS / 1000}s.`);
});

setInterval(checkAndTriggerPayments, PAYMENT_POLL_INTERVAL_MS);

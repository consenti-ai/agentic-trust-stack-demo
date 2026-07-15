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

// SHA-256 of secretvm-files/additional-files.tar — must be kept in sync if
// that file's contents ever change. Required for the real TEE workload
// verification check; the live RTMR3 measurement includes this file's
// contribution, which isn't recoverable from the deployed /docker-compose
// endpoint alone. Confirmed with Secret Network directly (see
// secretvm-files/DEPLOYMENT-NOTES.md).
const ADDITIONAL_FILES_SHA256 = 'feaf68905c1079e6d91a6c21eb49b44ad1ac59300d182b204596ed49683b1bb8';

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

// Real Layer 1 TEE attestation — checks THIS running deployment against
// Secret Network's own attestation service. Fails gracefully (available:
// false) when not actually running on a SecretVM, e.g. during local dev.
async function checkOwnAttestation(host) {
  const { checkSecretVm } = await import('secretvm-verify');
  const result = await checkSecretVm(
    host,
    undefined, // product (AMD only, auto-detected)
    false, // reloadAmdKds
    false, // checkProofOfCloud
    { dockerFilesSha256: ADDITIONAL_FILES_SHA256 },
  );
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

    return send(res, 201, {
      status: 'created',
      agreement_hash,
      party,
      committed_at,
      blocksee_agreement: blockseeAgreement,
    });
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
      ],
      agreement_hash: AGREEMENT_HASH,
    });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Consenti demo server listening on http://localhost:${PORT}`);
  console.log(`agreement_hash: ${AGREEMENT_HASH}`);
  console.log(BLOCKSEE_API_KEY ? 'Blocksee API key loaded.' : 'WARNING: no Blocksee API key found — commit will fail.');
});

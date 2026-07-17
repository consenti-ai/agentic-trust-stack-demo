# SecretVM deployment notes

`docker-compose-secretvm.yaml` must stay comment-free. Every previous
version with comments — even just documentation — caused the SecretVM
dashboard's Launch button to fail with `Docker Compose Update failed. r.get
is not a function`. The dashboard appears to do some lightweight/non-YAML-
library parsing of the pasted text (possibly for syntax highlighting), and
comments reliably broke it. Keep any explanatory notes here instead, never
in the file itself.

## Update 2026-07-18: dropped the Additional Files tar entirely

Compared our compose file against Certisyn's own real, working deployment
(`plum-cicada.vm.scrtlabs.com`, fetched live via `secretvm-verify --compose
--vm <domain>` — a public endpoint) and found they use a top-level
`configs:` block with the TLS/routing config inline, no separate Additional
Files tar at all — the **exact same feature that crashed our dashboard**
weeks ago. Their version has no comments anywhere in it. Best explanation:
it was the **comments**, not the `configs:` feature itself, that broke the
dashboard parser — we happened to have both in the same file when we first
hit the crash, and wrongly attributed it to `configs:` alone.

`docker-compose-secretvm.yaml` now uses this same pattern: a top-level
`configs:` block defines Traefik's TLS store and routing rule inline, no
`dynamic-config.yml` / `additional-files.tar` upload needed. This also means
`secretvm-verify` no longer needs `--docker-files` — same as Certisyn's own
deployment, which passes all three checks with zero extra flags. `server.js`
no longer passes `dockerFilesSha256` to `checkSecretVm()`.

**Not yet confirmed working on our own dashboard** — this is prep for the
next deployment, not yet tested end-to-end. If the dashboard crash somehow
recurs even without comments, the tar-based fallback (kept in
`secretvm-files/additional-files.tar` + `dynamic-config.yml` for now, not yet
deleted) is the proven-working alternative — see below.

## Fallback: the old tar-based approach (if configs: ever breaks again)

1. **No top-level `configs:` block.** Move Traefik's TLS + routing config
   into `dynamic-config.yml`, delivered via the "Additional Files (.tar)"
   upload instead of inline in the compose file.

2. **No `/var/run/docker.sock` mount, no `--providers.docker=true`.**
   Traefik originally used Docker-label-based dynamic discovery, which needs
   the Docker socket mounted. SecretVM's compose runner silently dropped the
   entire `traefik` service when it requested that mount — logs showed only
   the `app` image ever being pulled, no error, no `traefik` container, no
   custom network (just Compose's default). Best explanation: the socket
   mount is a known container-escape vector and gets silently stripped.
   Fixed by configuring Traefik statically instead (`dynamic-config.yml`
   defines the router/service directly, pointing at `app:3000` over the
   internal compose network) — no Docker provider needed at all.

3. **`app` has no `ports:` mapping.** Confirmed via direct testing that
   SecretVM does **not** auto-proxy arbitrary container ports to the
   internet — only its own attestation API on `:29343` is externally
   reachable by default. A reverse proxy (Traefik) binding 80/443 directly
   is required; the app's own port only needs to be reachable *inside* the
   compose network, which Traefik reaches via the service name `app`.

4. **Traefik's rule is `PathPrefix(\`/\`)`, not `Host(...)`.** SecretVM has
   no in-place update — every redeploy requires a brand new VM, which gets a
   new random domain (`tan-toucan` → `coffee-chimpanzee` → `teal-toad` →
   `turquoise-macaw` → ...). Pinning the router to one domain meant
   re-editing and re-uploading this file after every single relaunch. Since
   this VM only ever runs one app, there's no need to discriminate by
   hostname — a catch-all rule means this file works for whatever domain
   gets assigned, permanently.

5. **Cert paths `/certs/secret_vm_fullchain.pem` / `/certs/secret_vm_private.pem`**
   were an educated guess (copied from Secret Network's own reference
   chatbot deployment) — confirmed correct via a real successful TLS
   handshake against the deployed domain.

6. **SecretVM auto-injects `env_file: - usr/.env` into every service**
   regardless of what's declared in the submitted compose file — this is how
   "Encrypted Secrets" entered in the dashboard actually reach the
   container. Visible by fetching the live compose back via
   `secretvm-verify --compose --vm <domain>`.

## Verifying a deployment (all three checks)

**New `configs:`-based deployments (current approach, no tar):**
```
secretvm-verify --secretvm <domain>
```
No extra flags needed — same as Certisyn's own deployment.

**Old tar-based deployments (fallback approach, if ever reverted to):**
```
secretvm-verify --secretvm <domain> --docker-files secretvm-files/additional-files.tar
```
The `--docker-files` flag is **required** for `workload_binding_verified` to
pass in this case — without it, the check reports `FAIL` /
`"authentic_mismatch"` even against a genuinely correct deployment, since the
RTMR3 measurement includes the tar's contribution and that's not
recoverable from the live `/docker-compose` endpoint alone. (Confirmed with
Alex at Secret Network, 2026-07-14.) The tar passed must be the *exact* one
uploaded to that specific VM at deploy time — this repo's tar gets rebuilt
whenever `dynamic-config.yml` changes, so verifying an older tar-based
deployment against a since-rebuilt local tar shows a false mismatch.

# SecretVM deployment notes

`docker-compose-secretvm.yaml` and `dynamic-config.yml` (inside `additional-files.tar`)
must both stay comment-free. Every previous version with comments — even
just documentation — caused the SecretVM dashboard's Launch button to fail
with `Docker Compose Update failed. r.get is not a function`. The dashboard
appears to do some lightweight/non-YAML-library parsing of the pasted text
(possibly for syntax highlighting), and comments containing nested quotes or
backticks reliably broke it. Keep any explanatory notes here instead, never
in the files themselves.

## Why the compose file looks like this

1. **No top-level `configs:` block.** An early version put Traefik's TLS
   config there — same `r.get is not a function` crash as the comment issue
   above, but from the YAML feature itself, not comments. Fixed by moving the
   TLS + routing config into `dynamic-config.yml`, delivered via the
   "Additional Files (.tar)" upload instead.

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

```
secretvm-verify --secretvm <domain> --docker-files secretvm-files/additional-files.tar
```

The `--docker-files` flag is **required** for `workload_binding_verified` to
pass — without it, `secretvm-verify --secretvm <domain>` alone reports
`workload_binding_verified: FAIL` / `"authentic_mismatch"`, even against a
genuinely correct deployment. The RTMR3 workload measurement includes the
"Additional Files" tar's contribution, which isn't recoverable from the live
`/docker-compose` endpoint alone — the tool needs the original tar supplied
out-of-band to reconstruct the expected measurement. (Confirmed with Alex at
Secret Network, 2026-07-14.)

**Important:** the tar passed to `--docker-files` must be the *exact* one
that was actually uploaded to that specific VM at deploy time. Since this
repo's `additional-files.tar` gets rebuilt whenever `dynamic-config.yml`
changes, verifying an older deployment against a since-rebuilt local tar will
show a false mismatch — that's what happened testing earlier VMs
(`tan-toucan`, `turquoise-macaw`, etc.) before this flag's requirement was
understood. Always verify against the tar version that matches the
deployment being checked.

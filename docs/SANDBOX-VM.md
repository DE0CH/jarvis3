# Own sandbox hosts (sandbox provider "vm")

Status: **built and live** for YYC AI since 2026-10-21 (DE0CH/YYC `yyc-ai/deploy`). This is the third sandbox
provider next to `kubernetes` and `e2b` (docs/CHAT.md, "Sandbox providers"). It runs on our own VMs ("hosts") and
live-migrates a running sandbox from one host to another, so the scaler can empty a host and give it back. Code: host
agent `chat/sandboxd/` (`daemon/` in Rust, `host/setup.sh`, `host/make-certs.sh`, `aws/infra.sh`), controller and scaler
`chat/src/web/sandbox-vm.ts` + `vm-clients.ts`; the gVisor fork is [DE0CH/gvisor](https://github.com/DE0CH/gvisor)
(branch `main`, releases `precopy-*`, current `precopy-20261021.1`). The prototype scripts stay in
`chat/sandboxd/proto/`. What was built, and where it differs from the design below: "Built (2026-10-21)".

Deyao's requirements and decisions (2026-10-20):
- Not a Kubernetes cluster. We manage migration ourselves, and Docker-in-Docker doesn't work well there.
- Live migration that copies memory page by page while the sandbox runs, as AWS Nitro does, so the switch costs a few
  hundred ms at most.
- Every sandbox is an OCI container (the `chat/sandbox` image), and gVisor (runsc) is its isolation boundary against
  container escape.
- Hosts are ordinary VMs, never bare metal.
- **Shape A**: gVisor containers directly on the host VMs (no microVM). "Fork gVisor and build the live copy in, also
  fix the bug" (the TCP-after-restore bug below).
- **One always-on sandbox host on Hetzner is the baseline. AWS EC2 (eu-central-1) is only for scaling out beyond it.**
  No scale to zero. Sandboxes migrate between Hetzner and AWS in both directions, e.g. to drain AWS hosts back onto
  the Hetzner box when load drops.
- **No vCPU quota increase**: the AWS burst pool fits YYC's 16-vCPU eu-central-1 quota.
- **Docker in sandboxes: yes.** Installed in the sandbox image; dockerd starts on demand (first docker command), not
  at boot.
- **Package installs: yes** (2026-10-21): uid 1000 has passwordless sudo to the sandbox's own root (runsc
  `--allow-suid`), so `apt-get install` works through egress; gVisor stays the boundary ("Installing packages").
- The Hetzner box itself: Deyao approved a CX43 (2026-10-21). The CX line was sold out in fsn1/nbg1/hel1 that day,
  so an interim **cx23** (EUR 6.59/month) runs as the hub until a CX43 can be created ("Hub: interim cx23").

## Decision summary

| Question | Decision | Why |
|---|---|---|
| Isolation | gVisor (runsc, systrap platform) for every sandbox | Deyao's requirement. systrap needs no KVM, so it runs on any VM, Hetzner Cloud included. |
| Migration | **Pre-copy live migration in a gVisor fork** (`runsc checkpoint --migrate-to`, `runsc restore --migrate-listen`) | Upstream gVisor only has stop-and-copy checkpoints (0.94-1.04 s stopped for 1 GiB in use). The fork copies memory while the sandbox runs: **1 GiB busy (64 MiB/s of writes) between two EC2 hosts: stopped ~105-125 ms, a TCP peer sees a 109-127 ms gap**. |
| TCP across repeated migrations | Fixed in the fork (one setting wasn't restored); `--allow-connected-on-save` no longer needed | Upstream: connections survived only the first migration. The fix is a separate commit ready to send upstream. |
| Baseline host | One Hetzner Cloud **CX43** (8 vCPU, 16 GB, EUR 19.19/month gross), always on, in the yyc project | Same memory as an m7i.xlarge at ~1/9 of its price. The gVisor/overlay part was tested on a CX33 (same line). |
| Burst hosts | AWS EC2 **m7i.xlarge** (4 vCPU, 16 GiB) in eu-central-1, at most **3 hosts in steady state + 1 transient** = 16 vCPU | The quota is 16 vCPU and stays. The 4th slot exists only while a host is being drained into a fresh one (see "Scaler"). |
| Network | A WireGuard overlay. **The Hetzner box is the hub**: it sits in the yyc private network, peers with every AWS host, and is the route to the sandbox /32s on AWS | This collapses the earlier "sbx-gw" question: no separate gateway VMs. |
| CPU features | Every sandbox sees only the CPU features common to all hosts (gVisor annotation `dev.gvisor.internal.cpufeatures`) | AWS m7i is Intel (AVX-512), Hetzner CX is AMD EPYC: a sandbox started on Intel with AVX-512 can't be restored on the AMD box. |

## Built (2026-10-21)

### What runs (YYC AI)

| Part | Where | Notes |
|---|---|---|
| Hub `yyc-sbx-hub` | Hetzner yyc project, fsn1, **cx23 interim** (2 vCPU Intel Skylake, 4 GB), public 128.140.49.7, private 10.0.0.7 | sandboxd role `hub`, WireGuard hub (wg0 10.201.0.1, udp 51820), egress VIP translation, image source for AWS hosts. Firewall `yyc-sbx-hub`: in only udp 51820 + ICMP; no public SSH (SSH through yyc-master1 to 10.0.0.7). Hetzner network `yyc` route 10.200.0.0/15 → 10.0.0.7 |
| AWS burst hosts | eu-central-1a, launch template `yyc-ai-sandbox-host` (m7i.xlarge, AMI from `aws/infra.sh ami`, SG `yyc-ai-sandbox-host`: udp 51820 from the VPC only, IMDSv2 hop limit 1, no instance profile, no key pair, gp3 40 GB, terminate on shutdown) | started/terminated only by the scaler, as IAM user `yyc-ai-sandbox-scaler` (RunInstances from that template with tag app=yyc-ai-sandbox, m7i.xlarge only; tags at launch; TerminateInstances of app=yyc-ai-sandbox; DescribeInstances) |
| Cluster side | DE0CH/YYC `yyc-ai/deploy/sandbox-vm.yaml` | DaemonSet `kube-system/sbx-overlay-route` (each node: 10.200.0.0/15 via the private network; each egress pod: route to 10.200.0.0/16 with `rto_min 20ms`); policies egress ← 10.200.0.0/16:3128, web → :7070 and sandboxd :7443. SealedSecret `jarvis/sandbox-vm` (PKI + the scaler's AWS key) as web env |

### Gateway (since 2026-10-21: no always-on sandbox host)

Sandboxes run only on AWS burst hosts; the Hetzner hub `yyc-sbx-hub` is gone. Its network job moved to a **gateway**
on an existing k3s node (`yyc-pool-apps-worker2`, private 10.0.0.6), at no extra cost: sandboxd as the hub with
`gateway: true` (`chat/sandboxd/host/gateway.sh`, a systemd unit on the node, outside Kubernetes), which runs no
sandboxes (it reports all memory reserved: 0 slots) and no runsc. It keeps the hub's overlay address 10.201.0.1, its
WireGuard key and TLS certificate, so nothing else changed:

- WireGuard hub for the AWS hosts on **udp 51821** (flannel's own WireGuard has 51820), reached over the node's
  **IPv6** (cluster nodes have no public IPv4; they reach IPv4 through WARP): config `sandbox.vm.hub.endpoint` =
  `[2a01:4f8:c013:c93e::1]:51821`; AWS hosts got IPv6 (`aws/infra.sh ipv6`: Amazon /56 on the VPC, /64 on the subnet,
  ::/0 to the IGW, IPv6 egress in the SG; the template asks for one IPv6 address). Hetzner firewall `yyc-sbx-gw` on
  that server: in udp 51821 from ::/0.
- Egress VIP translation (10.201.1.1:3128 → an egress pod, source kept) and the image source for AWS hosts (:7444).
- Hetzner network `yyc` route 10.200.0.0/15 → 10.0.0.6; on the node itself `10.200.0.0/16 dev wg0 src 10.0.0.6` (the
  node's pods are masqueraded to its private address, which the sandboxes' nft lock admits).
- Host rules that touch only wg0's traffic (`hostRules` with `gateway`): nothing from wg0 to the public interface or
  back, wg0 may reach only sandboxd's API and image ports on the node itself (not the kubelet or anything else), the
  egress VIP only translated. The node's pods, kube-proxy, flannel and WARP keep their own rules. No packages, sysctl
  (beyond ip_forward, already on) or nftables.service are touched.
- **Sandbox sources through a k3s node** (fixed 2026-10-21, after AWS sandboxes' connections to the egress VIP timed
  out): flannel masquerades every non-pod source going to a pod (`! -s 10.244.0.0/16 -d 10.244.0.0/16 -j MASQUERADE`),
  so egress saw the node's flannel address and its NetworkPolicy (10.200.0.0/16 only) dropped the SYN; and flannel's
  own WireGuard would drop a 10.200.x source anyway (not in the node peer's allowed IPs). The gateway therefore sends
  what arrives on wg0 to pods over the private network (`ip rule iif wg0 lookup 51822`: 10.244.0.0/16 via 10.0.0.1,
  as from the old hub; Hetzner's per-node pod routes deliver it) and pins its source with an identity SNAT in its own
  table (`keep_source`, `priority srcnat - 10`: a connection's NAT is bound there, so iptables' masquerade never runs).
- **The node's own pods** (fixed 2026-10-21): a pod on the gateway node reaching a sandbox leaves through wg0, where
  flannel's masquerade would give it wg0's address 10.201.0.1, which the sandboxes' lock drops; the ui pod scheduled
  there timed out on every sandbox. `keep_source` also SNATs `oifname wg0, 10.244.0.0/16 → 10.200.0.0/16` to the
  node's private address. Checked from a pod on every node.
- **Routes survive systemd-networkd** (2026-10-21): networkd restarted on the node and dropped the routes it hadn't
  made (`10.200.0.0/16 dev wg0`, table 51822's pod route), cutting every sandbox off the controller and egress.
  gateway.sh and host setup set `ManageForeignRoutes=no` / `ManageForeignRoutingPolicyRules=no`, and sandboxd checks
  its routes (and each sandbox's /32) every 10 s and re-makes missing ones (logged "host routes were removed").
- A single point like the hub was: if the node is down, sandboxes can't reach egress or the controller until it is
  back (sandboxd restarts with it; wg0 and the nft table survive a sandboxd restart). Moving the gateway = run
  gateway.sh on another node with the same `/etc/sbx` files, point the Hetzner route and firewall at it, stop the old.
- Fixed with it: a burst host's forward chain dropped its sandboxes' packets to the egress VIP (a rule meant for the
  hub), so sandboxes on AWS could not reach egress; the rule is the hub's only now (test in `vm.test.ts`).

### Addresses and paths

- 10.200.0.0/16: sandboxes (one fixed /32 each, `sandboxes.ip`); 10.201.0.0/24: hosts on wg0 (hub .1, AWS .10–.250);
  10.201.1.1: the egress VIP.
- **Sandbox → egress:** sandbox → its host's veth → (AWS: wg0 → hub) → hub DNATs 10.201.1.1:3128 to one egress pod
  (`numgen random` over the pods' addresses, which egress pods announce in `kv egress_pod:*` and the scaler pushes,
  `PUT /v1/egress`) → private network (Hetzner's per-node pod routes) → egress pod. The **source is never NATed**:
  egress sees the sandbox's own /32 and accepts its token only from there. Replies go node → 10.200.0.0/15 → hub
  (reverse DNAT) → veth or wg0. The design said "no NAT on the way"; a stable proxy address the sandboxes keep for
  hours needs one translation, so it sits on the hub, which is on every path: a moved sandbox's connection keeps its
  conntrack entry and survives (measured).
- **Controller → sandbox / sandboxd:** web pod → node (masqueraded to the node's private address, 10.0.0.0/16, which
  is the `controlCidr` the nft lock admits on :7070) → hub → veth or wg0 → host.
- AWS hosts peer the hub (endpoint = its public IPv4) and each other (VPC addresses, for AWS↔AWS migrations); the hub
  learns their endpoints from the handshakes. The hub's peer list (each AWS host's /32 plus the /32s of its
  sandboxes) is rewritten by the controller after every placement and migration.

### sandboxd (`chat/sandboxd/daemon`, Rust, one static binary with a fixed memory budget: docs/SANDBOXD-MEMORY.md)

- API (HTTPS, TLS 1.3, mutual TLS; only the client certificate CN `sandbox-controller` is accepted; listens on the
  host's wg0 address): `GET /v1/host`, `PUT /v1/peers`, `PUT /v1/egress` (hub), `POST /v1/images`,
  `GET|POST /v1/sandboxes`, `DELETE /v1/sandboxes/{name}`, `GET /v1/sandboxes/{name}/spec`,
  `POST|GET /v1/sandboxes/{name}/receive`, `POST /v1/sandboxes/{name}/send` (409 = not moved, still running here;
  the answer has the scratch copy's figures, `scratch`).
  The hub also serves unpacked images to burst hosts (plain HTTP on 10.201.0.1:7444, overlay hosts only).
- State per sandbox in `/var/lib/sbx/sandboxes/<name>.json` (mode 600). The unit has `KillMode=process`: restarting
  or upgrading sandboxd never touches sandboxes (checked: setup.sh re-run with two sandboxes running, same PIDs).
- Every sandbox: `runsc --platform=systrap --network=sandbox --overlay2=none --host-uds=none
  --host-fifo=none --net-raw --allow-packet-socket-write --allow-suid`, the pool's CPU features (annotation), cgroup
  `/sbx/<name>` (memory = `sandbox.memory`, CPU quota = `sandbox.cpu`, pids 4096), its own netns. Its files
  (docs/CLAUDE-CODE.md "Storage"): root = Linux overlayfs (the image read-only + `upper/` on the sandbox's 5 GiB ext4
  scratch file), `/tmp` and `/var/lib/docker` on the same scratch, `/workspace` and `~/.claude` from the host's JuiceFS
  mount (a sandbox with a workspace or user is refused, 503, on a host without it; `sbx-jfs.service` counts as started
  only once the mount is there and sandboxd starts after it, so a freshly launched host never refuses one). `ws/` and
  `users/` belong to uid 1000 (sandboxd sets it), so the UI can remove a deleted conversation's folder. The
  first process is `sbx-init.mjs` (root inside gVisor, the Docker capabilities exist only there): it writes
  `/etc/hosts` and apt's proxy setting, starts the agent through setpriv as uid 1000 with no capabilities (bounding
  set kept, no no_new_privs: sudo works inside, see "Installing packages"), and dockerd only when the `docker` wrapper
  asks.
  `/var/lib/docker` is on the scratch filesystem, so images migrate with it (the scratch copy below).
- Host setup: `host/setup.sh hub|burst [image]` (idempotent: the fork's runsc checked against SHA256SUMS, crane,
  sandboxd's binary from `bin/` (`host/fetch-sandboxd.sh`: the CI release `sandboxd-<commit>`, checked), sysctls, the tmpfs for migration images, units, logrotate, the image unpacked). Burst images get each
  instance's `host.json`, WireGuard key and TLS files from EC2 user data at first boot (`sbx-userdata.service`).
- PKI: `host/make-certs.sh` (CA, hub and AWS server certificates "sandboxd", controller client certificate); in the
  `yyc` store as `YYC_SBX_*` (the CA key only there).

### Controller and scaler as built

- Placement and capacity: slots per host = min(memory − reserve over `sandbox.memory`, CPUs × `cpuOvercommit` over
  `sandbox.cpu`, `vm_hosts.max_sandboxes`). YYC: `sandbox.memory` 1Gi, cpu 1; hub reserve 1 GiB → 2 slots on the
  cx23; an m7i.xlarge has 15. `maxActive` 10. `spareSlots` 0 while the hub is the cx23 (else every second
  conversation would keep an AWS host up); 1 once the CX43 runs.
- Scale out (capacity planning, `VmController.launch`/`plan`): **available** = free slots on ready hosts (the only
  room placement uses: never a booting host), **pending** = the slots of booting hosts, **planned** = available +
  pending; **need** = `spareSlots` + people who may need a sandbox soon (kv `sandbox_demand:<email>`, counted 2 min;
  sent by `POST /internal/cc/warm` when someone types in the CloudCLI composer in a conversation without a live
  sandbox, docs/CLAUDE-CODE.md "Warming") + sandboxes waiting for a host. want = need − planned; want > 0 starts
  ceil(want / slots per host) AWS hosts at once, at most `aws.maxHosts` (3; a 4th only while a host is `retiring` and
  its sandboxes have nowhere to go). Decided and recorded under one Postgres lock, booting rows inserted before
  RunInstances, so the next request on any replica already counts their slots: a burst larger than a host → enough
  hosts at once. Sandboxes are made when the UI first runs Claude Code in a conversation (docs/CHAT.md, "Sandbox
  lifecycle"). With every host at `maxHosts` `/internal/cc/sandbox` fails with "all sandbox hosts are full".
- Release (one rule): an AWS host is terminated as soon as it has no sandbox and is older than
  `vm.minHostLifetimeSeconds` (900 = 15 min, from launch). Nothing else keeps or ends it.
- Packing (`chat/src/web/packing.ts`, a pure function; host age plays no part in it):

  ```
  target = current placement
  for each host h in use, least loaded first (ties: its sandboxes moved least recently):
    place h's sandboxes, biggest first, on the other hosts in use, each on the fullest one it fits (best fit)
    all fit -> they go there in the target (h is empty in it); else h keeps them
  if target uses strictly fewer hosts than now: migrate each sandbox whose target host differs
  ```

  One migration per scaler pass (the plan is recomputed each pass); an emptied host goes by the release rule. No
  move rate limit: a move only happens when it lowers the number of hosts in use. Also while Claude Code or a command
  runs in the sandbox (verified live 2026-10-21: a command printing every 100 ms for 60 s and a pip install through
  egress, moved AWS→AWS and back mid-command: all 600 lines, no duplicates, exit code and pip intact, pauses 102 and
  84 ms); across clouds only if CPU use < `migration.idleCpu`
  and with `--migrate-max-downtime` = `migration.maxDowntimeMs` (500 ms): a move that won't converge leaves the
  sandbox running where it is (`migration-skipped`). Each move is recorded as `pack` (with the plan) and `migration`.
  A `retiring` host (the operator's) has its sandboxes moved off the same way.
- Every decision and migration goes to `vm_events` (launch, active, pack, migration with pause_ms, migration-skipped,
  terminate, host-lost); read them with SQL.
- Release: `DELETE` (nothing to save: `/workspace` and `~/.claude` are on JuiceFS); the next sandbox mounts the same
  folders and the UI is told `reset`. A full-memory checkpoint on release was not built.

### The fork, as used

- Release `precopy-20261021.1` adds `runsc checkpoint --migrate-max-downtime D`: when the live rounds end with the
  remaining dirty pages estimated to take longer than D to send, the migration is aborted before the sandbox is ever
  stopped (`ErrPrecopyNotConverging`); the receiver sees a truncated stream and cleans up. Measured: a 256 MiB
  rewriting loop at ~95 % CPU, AWS → hub with D = 10 ms: aborted after 9 rounds (12.6 s, 65 MB still dirty, ~611 ms
  estimated), the workload kept its PID and kept running.

### Measured live (2026-10-21, cx23 hub + m7i.xlarge)

| What | Result |
|---|---|
| sandboxd create on the hub | 0.4 s; turn: sandbox ready 2.4 s after "starting" |
| Burst: launch → host active (RunInstances, boot, sandboxd, WireGuard) | 48.5 s; the turn's sandbox ready 67 s after it asked |
| Drain-back AWS → hub, idle sandbox with a 400 MiB process | 9.1 s total, 1 round, 448 MB sent, final copy 17.6 ms, restore 159 ms; the process kept PID and memory |
| Drain-back AWS → hub, agent-only sandbox (Deyao's live conversation, after its turn) | 0.86 s, 30 MB, final 33 ms, restore 128 ms |
| 256 MiB writer (Python, page per 4 KiB), AWS → hub | 6.8 s, 8 rounds, 786 MB, final 83 ms, restore 143 ms |
| Same, hub → AWS | 3.2 s, 2 rounds, 346 MB, final 152 ms, restore 38 ms |
| Empty AWS host terminated after its last sandbox left | 6 s later (scaler pass) |
| Isolation from inside a sandbox | uid 1000, CapEff/CapBnd 0, NoNewPrivs 1; env: only the proxy (egress token) and settings; `/proc/1/environ` denied; hub, sandboxd, metadata, API server, internet and egress pods directly: blocked; allowlisted hosts through the proxy 200, others 403 |

### Operations

- **Upgrade sandboxd:** CI (workflow `sandboxd`) publishes release `sandboxd-<commit 12>` for every change of
  `chat/sandboxd/daemon`. AWS hosts: a new AMI (below; `aws/infra.sh ami` takes the newest release, or
  `SANDBOXD_RELEASE=`), new hosts use it. The gateway: `host/fetch-sandboxd.sh <dir>` next to a copy of `host/`, then
  `gateway.sh` there. A restart never touches sandboxes (KillMode=process) nor the gateway's wg0/nft (egress targets
  are kept across restarts). Upgrade runsc: `GV=<release>`, then a new AMI; a migration needs the same runsc on both
  ends, so retire the old hosts (`update vm_hosts set status='retiring'`), whose sandboxes move to fresh hosts.
- **New AMI** (new sandboxd/runsc, or to pre-cache a new sandbox image): `aws/infra.sh ami <image>`, `aws/infra.sh
  template <ami>`, `aws/infra.sh prune-amis`. Running hosts are unaffected; new hosts use it.
- **Add capacity:** raise `aws.maxHosts` (the quota allows 3 m7i.xlarge + 1); a bigger hub: see below.
- **Drain a host by hand:** `update vm_hosts set status = 'retiring' where name = …` (AWS: terminated when empty;
  the hub: its sandboxes move to AWS; set it back to `active` after). **Cap a host:** `max_sandboxes` (0 = no new
  sandboxes; null = by memory). **Force a burst (test):** hub `max_sandboxes = 0`, then back to null: the scaler
  drains the AWS host back.
- **Hub: interim cx23 → CX43** (when the CX line is back in stock): create the CX43 by hand (same firewall, network
  `yyc`), `setup.sh hub` with the hub's TLS files from the store; then at a quiet time mark the old hub `retiring`
  so its sandboxes move to AWS, point the network route 10.200.0.0/15 at the new box and swap the names (or release
  the two hub sandboxes: files are saved, the next turn gets the reset note), then delete the cx23. Set
  `spareSlots` 1.
- **Logs:** web `vm:` lines (`kubectl -n jarvis logs deploy/web | grep '"vm:'`), table `vm_events`; on a host
  `journalctl -u sandboxd`, `/var/log/sbx/<sandbox>.log`.

### Cost (monthly)

- Hub: cx23 EUR 6.59 now (CX43 EUR 19.19 when it replaces it); AMI snapshot ~USD 0.33.
- AWS only while bursting: USD 0.2415/h per m7i.xlarge + IPv4 0.005/h + gp3; drain-back traffic USD 0.09/GB (an idle
  sandbox ~30 MB, one with 400 MiB in use ~0.45 GB).

## How the provider contract maps

The web role's interface to a sandbox is the agent on :7070 with `X-Jarvis-Exec-Token`, plus egress with the
sandbox's token; the UI uses the same agent (`/proc`).

- **Lifecycle:** owned by `chat/src/web/sandbox.ts` (docs/CHAT.md, "Sandbox lifecycle"). Migration is invisible to
  it: the sandbox keeps its id, IP, tokens, `boot_id`, processes and files, and a running `/proc` connection survives.
- **No secrets** inside a sandbox: its environment holds the proxy URL with its egress token, the mirror settings,
  its exec token and Claude Code's settings (the egress token again; no model key).
- **Egress only through our proxy.** Each sandbox gets nftables rules on its host. It may reach only egress:3128
  (through the overlay) and answer the controller and the UI on :7070. It cannot reach the host itself or the cloud
  metadata service. Its connection to egress is the plain HTTP proxy on 3128, without `/wire`: the overlay carries it
  straight to the egress pods, with no NAT on the way.
- **Provider `vm`** (`chat/src/web/sandbox-vm.ts`) implements `SandboxProvider`:
  - `create(row, egressToken)`: the controller places the sandbox on a host and calls that host's sandboxd
    `POST /v1/sandboxes {name, ip, image, env, cpu, memory, cpuFeatures, workspace, user}`.
  - `waitReady`: returns `{url: "http://<overlay ip>:7070", headers: {}}`. The URL never changes, even after
    migrations.
  - `keepAlive`: a no-op. The janitor owns release.
  - `destroy(name)`: `DELETE /v1/sandboxes/{name}` on whichever host holds the sandbox now.
  - `list()`: the union of every host's `GET /v1/sandboxes`.
- **Host dies:** its sandboxes are gone. The next `/internal/cc/sandbox` creates a fresh sandbox (`reset`); the
  conversation's `/workspace` and `~/.claude` are on JuiceFS, unchanged.

## Components

```
Hetzner fsn1 (yyc project)                                              AWS eu-central-1 (burst, <= 16 vCPU)
┌───────────────────────────────────────────────┐                     ┌─────────────────────────────────────┐
│ YYC cluster: web (controller: placement,      │                     │ host i (m7i.xlarge): sandboxd        │
│   scaler, migration, provider "vm"),          │──HTTPS+mTLS────────▶│   runsc sandboxes, netns + nft lock  │
│   egress :3128 ◀── sandbox IPs, no NAT        │   (over WireGuard)  │   wg0 peer of the Hetzner box        │
│                                               │                     │   /run/sbx/ckpt tmpfs                │
│ sandbox box (CX43, always on): sandboxd,      │◀══ WireGuard ══════▶│                                     │
│   runsc sandboxes, WireGuard hub (wg0),       │   (also carries     └─────────────────────────────────────┘
│   route for every sandbox /32 on AWS          │    migrations)
└───────────────────────────────────────────────┘
```

### sandboxd (one per host; the prototype is `sbx.sh`)

- **Lifecycle:** it creates, starts, migrates and deletes sandboxes (runsc containers). It serves
  `GET/POST/DELETE /sandboxes`, `POST /sandboxes/{id}/send {to}` and `POST /sandboxes/{id}/receive`.
- **Image cache:** `crane export` of the pinned sandbox image into `/var/lib/sbx/images/<digest>/rootfs`. Every
  sandbox shares it read-only. gVisor's `--overlay2=root:self` keeps each sandbox's writes in its own upper layer,
  which travels with the sandbox. New hosts start from a prepared image with it cached (AMI on AWS, snapshot on
  Hetzner).
- **Networking per sandbox:**
  - A network namespace with a veth pair. The sandbox address is `<ip>/32`, its default route goes via
    `169.254.1.1`, and the host answers that with proxy ARP (`proxy_delay=0`; Linux's default delays each answer by
    up to 0.8 s).
  - The host side has the same MAC (`ee:ee:ee:ee:ee:ee`) on every host, and the sandbox side's MAC is derived from
    its IP, so a moved sandbox's ARP cache stays valid.
  - MTU 1420 (the overlay's) on every host, so a sandbox's packets fit wherever it runs.
  - One stateless nftables table per sandbox: out only to `egress:3128`, in only from the controller to `:7070`,
    nothing to the host itself. Stateless, because a connection arriving mid-stream on a new host has no conntrack
    entry.
- **CPU features:** each bundle carries the annotation `dev.gvisor.internal.cpufeatures` with the features all hosts
  of the pool have (`runsc cpu-features` on each host type, intersected; Intel m7i ∩ AMD EPYC-Rome = 64 features,
  no AVX-512). See "CPU features across clouds".
- **Migration send/receive:** see "Migration". Between hosts the stream runs over WireGuard, which authenticates
  both ends.
- **Auth:** the controller calls sandboxd over HTTPS with mutual TLS, through the overlay.

### Controller and scaler (in the web role, behind a leader lock like the janitor)

- **Placement:** a new sandbox goes to the Hetzner box while it has room (memory counted by the sandbox limit,
  `sandbox.memory`, plus headroom for one incoming migration; CPU overcommitted, default 3×, since chat sandboxes are
  idle most of the time). When it is full, to the fullest AWS host that still has room.
- **Overlay addresses:** a sandbox gets a free /32 from `10.200.0.0/16`, stored in new `sandboxes.host` /
  `sandboxes.ip` columns. The address never changes, whichever host the sandbox is on.
- **Scale out (AWS):** when placement finds no room, or room falls under one sandbox, the scaler asks EC2 for a host
  (`RunInstances` from the AMI, tagged `app=yyc-ai-sandbox`). Booting takes ~30-40 s, too slow while someone types,
  so the scaler keeps one sandbox's worth of free room (`sandbox.vm.spareSlots`).
- **vCPU cap:** YYC's eu-central-1 quota is 16 vCPU (Deyao: no increase). With m7i.xlarge (4 vCPU): at most **3 AWS
  hosts in steady state**, plus a 4th only while one is being replaced. The scaler never starts a 4th host to gain
  capacity. With the CX43 that is 1 + 3 hosts of 16 GB each: roughly 25-40 sandboxes at 1-2 GiB each.
- **Scale in (drain-back and defragmentation), never to zero:**
  - When the sandboxes on the emptiest AWS host fit into free room elsewhere (the Hetzner box first), the controller
    migrates them away one at a time, then terminates that host. EC2 bills per second (60 s minimum), so a host
    released early saves money at once.
  - The Hetzner box is never drained and never released: it is the baseline (no scale to zero).
  - A drain never interrupts a running bash call: the controller waits until the sandbox's agent is between
    commands (not built: moves happen mid-command and were verified live, see "Controller and scaler as built").
  - Moving AWS → Hetzner is billed as AWS internet egress ($0.09/GB): about the sandbox's memory in use plus what
    it rewrites during the copy (measured: 1.3 GB for 1 GiB at 8 MiB/s of writes). Prefer moving idle sandboxes.
- **Spot (optional):** a spot host's 2-minute interruption notice triggers the same drain. 2 minutes is enough for
  several migrations.
- **Failure:**
  - A host stops answering its heartbeat for 30 s: the controller marks its sandboxes `gone` and terminates the
    instance. The next `/internal/cc/sandbox` creates a fresh sandbox (`reset`: `/workspace` and `~/.claude` are
    there, installed packages and background processes are gone).
  - A migration fails while memory is being copied (the sandbox still runs on the source): nothing happens to the
    sandbox; the controller retries later or picks another target.
  - A migration fails during the final stop-and-copy (~0.1-0.5 s): the source has already stopped, so the sandbox
    takes the "host died" path. (Resuming the source in that case is possible future work in the fork.)

### Cross-cloud network

- **The Hetzner box is the WireGuard hub.**
  - It is a server in the yyc project's private network and runs WireGuard to every AWS host.
  - The Hetzner network has a route `10.200.0.0/16 → sandbox box`. The box routes each sandbox /32: to its own veth
    if the sandbox runs there, otherwise into WireGuard, where the /32 is in the AllowedIPs of the AWS host that has
    it. Moving a sandbox is one `wg set wg0 peer <host> allowed-ips ...` plus one route.
  - This replaces the two "sbx-gw" gateway VMs of the earlier design. Downside: the box is a single point for AWS
    sandboxes' connectivity; if it is down, they can't reach egress (they keep running). A second, small gateway can
    be added later if that matters.
  - Hetzner rule: the yyc project's token must not create or delete servers from automation. The box is created
    once, by Deyao; the AWS scaler never touches Hetzner.
- **Web and UI to sandbox:** the controller and the UI pods reach `<ip>:7070` through the same path (pods → Hetzner network
  route → box → veth or WireGuard → host → sandbox). The exec token is still required.
- **Sandbox to egress:** by its overlay address, so the connection survives a migration. Egress additionally checks
  that the source IP belongs to the token's sandbox.
- **Packets from the overlay need the right source address:** a peer that sends into `wg0` must use its own
  network address (not its `wg0` address) as source for the sandbox routes (`ip route ... dev wg0 src <addr>`),
  otherwise the sandbox's nft lock drops its packets (seen in the prototype with the controller's health checks).
- **Latency and bandwidth (measured, AWS eu-central-1 ↔ Hetzner fsn1 over WireGuard):** 6.9 ms RTT; one TCP flow
  40-180 MB/s AWS→Hetzner and ~100 MB/s Hetzner→AWS, varying from run to run. Between two EC2 hosts in one subnet:
  0.3-0.8 ms, 0.6-1.2 GB/s per migration stream.

## Migration (shape A, gVisor fork; prototype `migrate.sh`)

1. The target creates the same netns, veth, address, MACs and nft table, and the same bundle (same rootfs digest,
   runsc flags and CPU-feature annotation).
2. The target starts `runsc restore --migrate-listen 0.0.0.0:7000 --image-path /run/sbx/ckpt/in-<id> --background`.
   It listens at once and creates the sandbox (processes, gofer, sentry) while the stream arrives, so sandbox creation
   is not part of the pause.
3. The source runs `runsc checkpoint --migrate-to <target>:7000 --migrate-downtime 100ms <id>`:
   - **Round 0, sandbox running:** every allocated page of the sandbox's memory is sent.
   - **Further rounds, sandbox running:** pages written since they were sent go again, until what is left is
     estimated to take less than `--migrate-downtime` to send, the round limit (`--migrate-max-rounds`, 20) is
     reached, or two rounds in a row didn't shrink the dirty set (the sandbox writes about as fast as the link
     sends).
   - **Final, sandbox stopped:** the last dirty pages, the kernel state and the memory metadata. The source then
     exits.
4. The target restores the moment the stream ends. The sandbox's memory needs no loading: the receiver wrote it into
   a file that the restored sandbox uses as its memory directly.
5. The controller moves the /32 (one route, plus the WireGuard AllowedIPs when the target is across the overlay).
   It must not move before the restore returns.

### Scratch on migration (2026-10-21)

A sandbox's scratch filesystem (`/var/lib/sbx/scratch/<name>`: the overlay's `upper/` with every install, `/tmp`,
Docker's directory) is host disk, not memory, so it moves as files, with rsync, around the memory pre-copy above
(sandboxd `storage.rs`, `relay.rs`, `sandboxes.rs`):

1. **Receive:** the target prepares the same storage as a create (an empty 5 GiB scratch, the overlay on the same
   image digest, the JuiceFS folders) and the bundle, starts `runsc restore --migrate-listen 127.0.0.1:<port+1000>`,
   and `sandboxd migrate-relay` (a helper process in the helpers cgroup, so nothing of it is in sandboxd's memory
   bound) on `<overlay address>:<port>`, the port the controller gets as before. The relay serves the source's
   connections one at a time: rsync (`rsync --daemon` in inetd mode on the connection, module `scratch` = the scratch
   filesystem, chroot, root, overlay addresses only), the pre-copy stream (relayed to the restore record by record,
   except its End record, which it holds back), and `SBXDONE!`/`SBXFAIL!` from the source.
2. **Send, sandbox running:** up to 3 rsync rounds of the scratch (`rsync -aHAX --numeric-ids --delete`, overlayfs'
   work directory excluded), stopping early once a round copies under 32 MiB and 2,000 files. Files changing under
   rsync (exit 23/24) are fine here. A failure leaves the sandbox running (409).
3. **Memory pre-copy** (`runsc checkpoint --migrate-to <relay>`), unchanged. Its final step stops the sandbox and
   writes its dirty file data to the host files; then the stream ends with End, which the relay keeps.
4. **Sandbox stopped:** the final rsync delta, while `runsc delete` removes the stopped container (its gofer closes
   the sandbox's files, so JuiceFS commits the last writes to `/workspace` and `~/.claude` for the target, which
   mounts the same volume). Then `SBXDONE!`: the relay hands End to the restore, which restores. A failure here loses
   the sandbox (502), as a failure in the stopped part of the memory copy always did; `SBXFAIL!` makes the target's
   restore fail at once.
5. **The upper directories on the way to the bind mounts** (`/tmp`, `/var/lib/docker`, `/workspace`,
   `/home/sandbox/.claude` and their parents) are made in `upper/` before the overlay is mounted, on every host.
   runsc looks these paths up when it creates the sandbox (the target does that before the copy), overlayfs caches a
   directory it found only in the image, and the bind mount pins it: files copied into its upper twin afterwards
   would stay invisible.

What is preserved: contents, owners (numeric), modes, mtimes to the nanosecond (gVisor's restore checks the size
and mtime of every file the sandbox had open, so they must match), hard links, ACLs, xattrs (`trusted.overlay.*` of
opaque directories) and devices (whiteouts, 0/0 character devices). Inode numbers change; gVisor's gofer accepts that
on restore.

Measured on two m7i.large (eu-central-1, same AZ), 2026-10-21, a sandbox with apt (`cowsay`, `sl`), pip (`humanize`)
and npm -g installs, a deleted image file (whiteout), 200 MB in `/tmp`, 53 files in `/workspace` (one appended to every
second by an open file), and a process holding 300 MiB: A → B and back, everything intact (same PID, memory checked,
checksums, whiteout, the appending file and a shell loop writing `/tmp` and `/workspace` every few ms went on without a
gap in its sequence). Each move: scratch live rounds 0.7-0.8 s for 230 MB (2.9 s with the shell loop running),
`send` 1.9 s, final memory 190-370 ms, final scratch delta 130 ms (+20 ms for the delete and End: `stoppedMs` 150),
restore 59-67 ms; the largest gap the process saw: 330-800 ms (it also hashes its 300 MiB every 1.25 s, ~200 ms).

**Flags on both sides:** `--platform=systrap --network=sandbox --overlay2=none --host-uds=none
--host-fifo=none` (plus the Docker and sudo flags, runsc.rs). `--network=sandbox` means gVisor's own TCP/IP stack holds every connection, so connections are in
the migrated state. `--allow-connected-on-save` is not needed any more (see "The TCP bug").

**What moves:** processes (same PIDs and start times), the scratch filesystem (above) and tmpfs mounts, memory
(checked page by page in the tests), established TCP connections, the agent's `boot_id`, and Docker state inside the
sandbox. **What doesn't:** connections from outside to the sandbox that are in their handshake at the switch (the
probe's new HTTP connections then wait for a SYN retransmission, ~1 s).

### How the fork tracks dirty memory

gVisor's sentry owns all application memory (one memory file per sandbox, mapped into the application's address
space by the platform). The fork records writes there, without host kernel features (no soft-dirty, no
userfaultfd), so it works on any VM:
- **Application writes:** while a round runs, the sentry maps the sandbox's memory read-only. The first write to a
  page faults into the sentry, which marks that page dirty and maps only that page writable. Each round begins by
  write-protecting again. (To bound the number of host mappings this splits, the sentry write-protects early after
  16384 pages.)
- **The sentry's own writes** (`read()` into application buffers, file writes into tmpfs/overlay, page zeroing,
  page freeing) are marked where they happen. Writes through long-lived internal mappings (the vDSO data page,
  io_uring rings) count as dirty until the final round.
- Each round's dirty set is a bitmap per memory file. Tracking costs one fault per newly written page per round and
  nothing when no migration is running.

### The TCP bug

Upstream (gVisor release-20261012.0), without `--allow-connected-on-save`, established TCP connections survived a
sandbox's first checkpoint/restore and were aborted (`ECONNABORTED` inside, nothing sent to the peer) on the next one.
`stack.Stack.allowLiveTCPMigration` was `state:"nosave"`: a restored stack reported `false`, and TCP endpoints
check it when they are saved. The fix saves it, and the restoring sandbox's configuration overrides it
(DE0CH/gvisor commit `913bf5cf9`, test `TestTCPMigrationRepeated`). It is a separate clean commit on branch
`upstream/tcp-migration-fix`, ready to send upstream.

### CPU features across clouds

- AWS m7i is Intel Sapphire Rapids (AVX-512, AMX); the Hetzner CX line is AMD EPYC (CX33: EPYC-Rome, no AVX-512).
  gVisor refuses to restore a sandbox whose saved CPU features the new host lacks (`incompatible FeatureSet: missing
  features: ... avx512f ...`, seen in the test).
- So every sandbox is started with the pool's common feature set (annotation `dev.gvisor.internal.cpufeatures`;
  64 features for m7i ∩ EPYC-Rome; x86-64-v3, i.e. up to AVX2). On Intel, the host supports CPUID faulting and
  gVisor hides everything else from the application: glibc inside picks x86-64-v3 code paths instead of v4.
- On the AMD box the host has no CPUID faulting (EPYC-Rome): applications there see the real AMD CPUID. The only
  AMD-specific features it adds (`sse4a`, `mmxext` flags, `misalignsse`, ...) aren't used by mainstream software, but
  a program that checks for `sse4a` at start on the box and then moves to AWS could hit an illegal instruction.
  Choosing host types with the same CPU vendor removes even that (e.g. AMD on both sides); not tested.
- Adding a host type later changes the common set: sandboxes started with the old set may not fit the new type.

### Shape B (not chosen), Cloud Hypervisor microVM

For the record (measured 2026-10-20): Cloud Hypervisor's pre-copy with gVisor inside the guest paused 48-77 ms at
1 GiB busy and a TCP peer saw ~255 ms; it needs nested virtualisation (m7i has it at no extra price; Hetzner Cloud
doesn't). The scripts (`vm.sh`, `vm-migrate.sh`, `vm-run-test.sh`) stay in the prototype directory.

### Host memory (measured on the cx23 hub, 2026-10-21)

What a host needs outside its sandboxes, and what a sandbox costs outside its own limit:

- **Everything a sandbox runs is inside its cgroup** `/sbx/<name>` with the sandbox's limit: the runsc `exe`, the
  sentry and the gofer, the sandbox's memory (a memfd, `shmem`), and the kernel memory and page tables they cause
  (idle sandbox: ~40 MiB in total, of it ~3.3 MiB kernel and ~2 MiB page tables; a 400 MB process inside: 447 MiB,
  ~5.5 MiB kernel and ~3 MiB page tables). Outside it: only runsc's `runsc-fd-parking` sidecar (~8 KiB RSS, in
  sandboxd's unit) and the netns/veth/nft objects. With three sandboxes filled to ~447 MiB the host side did not
  move (498 vs 493 MiB), so the overhead outside the limit is ~0.
- **Host side** (MemTotal − MemAvailable − the sandboxes' cgroups): 493-548 MiB. Userspace PSS outside `/sbx`
  ~195 MiB: sandboxd (Node) RSS 104-105 MiB / PSS ~100 (its cgroup: ~50-64 MiB, ~49 MiB anonymous; the rest is
  Node's binary, shared page cache), multipathd 23, unattended-upgrades 17, systemd 6, journald/resolved/sshd/
  networkd/udevd/polkitd 3-4 each; WireGuard is a kernel module (no process). Kernel: SUnreclaim ~62 MiB, vmalloc
  ~19, stacks ~4, page tables ~2 outside the sandboxes; the zone watermarks hold ~99 MiB (min_free_kbytes 66 MiB) that
  MemAvailable never counts; the rest is hot page cache (binaries).
- **sandboxd under load:** RSS 104.1-105.4 MiB (1 s samples) idle, while creating 4 sandboxes at once, during a
  Docker build in one and with 3 sandboxes filled: it barely moves (sandboxd only controls; the sandboxes and
  runsc's migration streams are other processes). Not measured during a live migration (no AWS host was up); a
  migration's data is streamed by the runsc processes, not by sandboxd.
- **Migration receive:** `runsc restore --migrate-listen` joins the new sandbox's cgroup before it receives, and the
  received pages are written at their offsets into that sandbox's `memory.img` (tmpfs, its memory afterwards), so a
  receive is charged to the incoming sandbox's own limit (pages resent in later rounds overwrite, they don't add)
  and needs one free slot, nothing from the host side.
- **Hub, 512 MiB sandboxes:** reserve 700 MiB (`SBX_RESERVE_MIB=700`) → (3819 − 700) / 512 = **6 slots**; the six
  at their full 512 MiB (3072 MiB) plus the measured host side (~500 MiB) leave ~200-250 MiB. So 6 fits with every
  sandbox at its limit, not only because sandboxes usually sit far below it.
- **Isolation** (`host/setup.sh`): sandboxd's unit has MemoryMin 160M (reservation; system.slice gets the same so
  it takes effect), MemoryHigh 384M (reclaim/throttle, e.g. page cache of image unpacks) and MemoryMax 512M (hard);
  `/sbx` is capped at MemTotal − reserveMemory (`sbx-cgroup`, run before each sandboxd start; on the hub 3119 MiB),
  so sandboxes can never take the host's reserve and sandboxd can never take theirs. Checked on the hub: applying it
  restarted sandboxd and all five running sandboxes kept their PIDs. The limits sit on the unit, not on a slice of
  its own: the fd-parking sidecars stay in the unit's cgroup (KillMode=process), so systemd could never move the
  unit to another slice while sandboxes run.
- **Over its limit a sandbox dies whole.** gVisor reports the cgroup limit as the sandbox's total memory (`free`
  shows 512 MiB) but has no OOM killer of its own: when sentry + gofer + the sandbox's memory reach the limit, the
  host kernel's memcg OOM killer kills the sentry (seen: shmem 376 MB + sentry anon 73 MB + file 64 MB). What the
  sandbox can use is about the limit minus ~50-70 MiB. `/workspace` is safe (on JuiceFS); the next
  `/internal/cc/sandbox` gets a new sandbox (`reset`).

## Docker in sandboxes

Design (Deyao, 2026-10-20): Docker is installed in the sandbox image; dockerd starts on demand, on the first
`docker` command (a small wrapper in the image starts it and waits for its socket), not at boot, so sandboxes that
never use Docker pay nothing for it.
- **Runtime settings** (gvisor.dev/docs/tutorials/docker-in-gvisor): runsc `--net-raw --allow-packet-socket-write`
  for Docker sandboxes; dockerd with `iptables: false, bridge: none`; inner containers with `--network=host`;
  `/var/lib/docker` on a tmpfs in the sandbox's memory, so images migrate with the sandbox. The capabilities Docker
  needs (CAP_SYS_ADMIN and so on) are the sandbox's own, inside gVisor; the sentry still runs with none on the host.
- **Pulls go through egress** like any other traffic (`HTTPS_PROXY`), so the egress lock still holds.
- **Measured** (prototype `docker-test.sh`, `docker:29-dind`):
  - dockerd answers 385-402 ms after it starts.
  - `python:3.12-slim` (166 MB unpacked) pulled through the egress proxy in ~3.5 s.
  - With hello-world, a small built image and python:3.12-slim: `/var/lib/docker` 179 MB; the sandbox's cgroup
    300-309 MB in total. So: an idle dockerd + containerd cost ~100-130 MB, and images cost their unpacked size in
    memory.
  - **Migration** with pre-copy: 234-239 MB sent; AWS↔AWS 0.74-0.81 s in total, stopped ~0.34-0.42 s; AWS↔Hetzner
    3.1-3.6 s in total, stopped ~0.55-0.58 s. After every move `docker images` lists the same images and the pulled
    and built images run. The longer stop than an agent-only sandbox comes from dockerd's and containerd's larger
    kernel state (2.8 MB vs 0.4 MB) and, on the box, its slower shared vCPUs.
- **At 512 MiB per sandbox** (2026-10-21, hub): dockerd starts on demand; `FROM busybox` + `RUN` build, pulled
  through egress, then `docker run`: 11.3 s, the sandbox's cgroup peaked at 174 MiB. Pulling `python:3.12-slim`
  (and running it) went over the limit (dockerd + containerd + the layer downloads and the unpacked image, all in the
  sandbox's memory) and the sandbox was killed (see "Host memory"). So at 512 MiB Docker is good for small images
  (busybox/alpine-based builds and runs, up to ~150-200 MB of images); Python/Node base images and anything bigger
  need a larger `sandbox.memory`.
- **Image size:** adding Docker (docker-ce CLI, dockerd, containerd, runc) to the sandbox image adds roughly
  100-150 MB to it; not built yet.

## Installing packages (2026-10-21)

Deyao (2026-10-21): "apt pip and other packages need to be installable on the sandbox". pip (venv `/opt/py`) and npm
(prefix `~/.npm-global`) already worked as uid 1000; `apt-get install` needs root.

**Design: uid 1000 gets passwordless sudo inside the sandbox; gVisor stays the boundary.**
- runsc `--allow-suid` (gVisor ignores set-user-ID bits without it); the sandbox image has `sudo` with
  `node ALL=(ALL:ALL) NOPASSWD: ALL` (`/etc/sudoers.d/sandbox`), keeping the proxy and mirror variables
  (`env_keep`). `sbx-init.mjs` starts the agent as uid 1000 with empty effective/permitted/inheritable/ambient
  capability sets but keeps the bounding set and doesn't set no_new_privs, so `sudo` can give a command the
  sandbox's root (the Docker capability set of the OCI spec, `DOCKER_CAPS` in `daemon/src/runsc.rs`, unchanged).
- `/usr/local/bin/apt-get` and `apt` (`chat/sandbox/apt-wrapper.sh`): as uid 1000 they re-run themselves through
  `sudo -n`, so `apt-get install -y x` and `sudo apt-get install -y x` both work; an install fetches the package lists
  first when the image has none (it ships without them); without sudo (kubernetes/e2b providers, no_new_privs) they
  say root isn't available (exit 100) instead of apt's lock-file error. `/etc/apt/apt.conf.d/90sandbox`: assume yes,
  no recommended packages, no pty.
- apt goes through egress like everything else: sudo keeps `http_proxy`/`https_proxy`, and `sbx-init.mjs` writes
  `/etc/apt/apt.conf.d/80sandbox-proxy` (`Acquire::http::Proxy`/`https::Proxy` = the sandbox's own proxy URL, mode
  644: uid 1000 has the same URL in its environment) so a root shell that reset its environment uses it too.
  `deb.debian.org`/`security.debian.org` are on the allowlist and their plain-HTTP GETs are cached by egress;
  `download.docker.com` (the image's Docker source) is allowlisted too, so `apt-get update` succeeds as a whole.
- `sbx-init.mjs` also writes `/etc/hosts` (an image has none): sudo resolves the hostname on every call, and without
  an entry each sudo waited for DNS (which the sandbox doesn't have) for ~80 s (measured locally).
- Installs land in the root overlay's upper layer (`--overlay2=root:self,size=5g`: in the sandbox's own filestore,
  capped at 5 GiB), which a live migration carries; the shared image rootfs on the host is never written (checked:
  after `apt-get install ffmpeg` as root inside, the host's `images/<digest>/rootfs` was unchanged, the sandbox's
  writes were all in `rootfs/.gvisor.filestore.<name>`).

**Why this is safe.**
- Root inside a sandbox is not new: `sbx-init.mjs` and dockerd already ran as that root with `DOCKER_CAPS`, and uid
  1000 could already get it through Docker (`docker.sock` belongs to its group: `docker run --privileged -v /:/h`).
  sudo makes the same thing direct.
- A uid inside gVisor is the sentry's bookkeeping, not a host uid: every syscall of the sandbox, root's too, goes to
  the sentry, which runs on the host in its own user namespace with a fixed small capability set, no_new_privs and
  its seccomp filter, whatever the uid inside (checked locally: runsc-sandbox/sentry processes `NoNewPrivs: 1`,
  `Seccomp: 2`, own user namespace, same credentials before and after `sudo` inside). An OCI user namespace on top
  (the design's "map root inside to an unprivileged host uid") would change nothing for the sentry and is therefore
  not added; `--allow-suid` only lets the sentry honour set-user-ID bits between its own virtual uids.
- What isolates a sandbox stays as it was: the host-side netns with the stateless nft lock (out only `<own ip>` →
  egress VIP:3128, in only from the controller to :7070; root inside can add addresses or raw sockets to gVisor's
  netstack, but the lock checks the source address on the host side), the cgroup (memory, CPU, pids), no host mounts,
  `--host-uds=none --host-fifo=none`, no secrets in the environment. The proxy token and exec token were already
  readable by uid 1000 (its own environment and the agent's).
- Migration: gVisor keeps `AllowSUID` in the sandbox's saved kernel state, so a sandbox keeps the setting it started
  with wherever it moves; restore doesn't compare runsc flags, and the OCI spec is unchanged (restore validates it),
  so hosts with and without the flag can exchange sandboxes during a rollout. A sandbox started before the upgrade
  keeps sudo off until it is reset; the new image on a host without the flag gets "sudo: effective uid is not 0".

**Verified live (2026-10-21, AWS m7i.xlarge hosts from launch template v5 = sandboxd-570eeac5d472, sandbox image
c7ab936375cd/84658bb83e85, sandboxes made through the real SandboxManager in a web pod):**
- uid 1000: `sudo -n id` → root; `NoNewPrivs 0`, effective capabilities 0 until sudo.
- `sudo apt-get update && sudo apt-get install -y ffmpeg sqlite3` (10.2 MB of lists in 1 s through egress; ffmpeg
  7.1.5 installed, ~40 s), plain `apt-get install -y cowsay iproute2` (the wrapper's sudo), `pip install polars`
  (2.0.0), `npm i -g cowsay`, uv's `curl -LsSf https://astral.sh/uv/install.sh | sh` (uv on PATH in ~/.local/bin),
  `docker run --rm busybox`: all work.
- Hardening checks as root (`sudo curl --noproxy '*'`): metadata 169.254.169.254, the host (169.254.1.1:7443), the
  gateway's sandboxd and image ports (10.201.0.1:7443/7444), another sandbox (10.200.0.10:7070), 1.1.1.1 and
  deb.debian.org directly: all time out; only the egress VIP :3128 answers. Through the proxy: pypi.org 200,
  pastebin.com and an unlisted name refused at CONNECT (403). Root adding a second address (10.200.0.99) and sending
  from it: dropped by the host's nft lock. The shared image rootfs on the host is never written (checked locally:
  installs land in the sandbox's own `.gvisor.filestore.<name>`).
- Live migration (host retired → new host): a sandbox with apt (cowsay, sqlite3), pip polars, npm cowsay, uv, a pulled
  busybox image and a running counter process: 362 MB sent, 1 round, pause 288 ms; afterwards the marker file, every
  install, `sudo`, `docker run` and the counter (still counting, same process) were all there.
- **Limit found: a sandbox whose memory plus root-overlay writes approach `sandbox.memory` dies on restore.** A
  sandbox with ffmpeg, polars, Docker and a pulled image (784–791 MB sent) was OOM-killed on the target right after
  the stream ended (EC2 console: `Memory cgroup out of memory: Killed process … (gvisor_sentry)` in the sandbox's 1 GiB
  cgroup); runsc still listed it as running, the next `ensure()` found it unhealthy and made a fresh sandbox (files
  restored, the reset note). On the source the overlay's filestore is a host file whose pages are reclaimable; on the
  target the received image sits in tmpfs charged to the sandbox's cgroup while the restored sandbox's memory and
  filestore fill up, so the same contents count about twice. Not caused by sudo (pip/npm/`/work` writes go to the
  same overlay), but apt makes big overlays likelier. Fix candidates (sandboxd/fork, not done here): raise the
  cgroup's memory.max by the received image's size until restore finishes, or have the receiver write filestore
  pages straight into the target's filestore file as it does for the main memory file; or have the controller skip
  moving a sandbox whose memory + overlay use is above ~60 % of its limit.

**Order of a rollout:** sandboxd with `--allow-suid` first (new AMI, retire the AWS hosts), then the sandbox image
(`sandbox.image`).

**sandboxd's part** (`chat/sandboxd/daemon/src/runsc.rs`; the Node daemon had it too until it was removed): the runsc flag
`--allow-suid` in the global flags (same list as before otherwise, tested); the OCI spec unchanged (root,
`DOCKER_CAPS` in bounding/effective/permitted, no `noNewPrivileges`, no user namespace). Everything else lives in
the image.

## Measured (2026-10-20/21)

**Setup:**
- AWS: two EC2 m7i.xlarge (4 vCPU, 16 GiB, Intel Sapphire Rapids) in one eu-central-1 subnet, Ubuntu 24.04
  (kernel 7.0); a t3.small as egress stand-in and controller.
- Hetzner: one Cloud CX33 (4 shared vCPU AMD EPYC-Rome, 8 GB) in fsn1, Ubuntu 24.04 (kernel 6.8), a temporary
  stand-in for the baseline box; WireGuard mesh to the three AWS VMs.
- gVisor: DE0CH/gvisor release `precopy-20261020.3` (AWS↔AWS and Docker) and `.4` (Hetzner; `.4` only adds the
  "not converging" stop, which AWS↔AWS runs never reached). systrap.
- Sandbox image `ghcr.io/de0ch/jarvis3-sandbox:288ec849eab9`; all sandboxes with the 64 common CPU features.

**Workload** (`run-matrix.sh`): `workload.py memcheck N R` holds N MiB and rewrites R MiB/s of random 4 KiB pages,
recording each page's version in the page and in a separate list; every 5 s it checks every page (a write lost by a
migration shows up as a page older than its version). `workload.py heart` keeps one TCP connection through the
egress proxy and echoes a line every 20 ms; the egress side logs every gap over 100 ms (the outage a peer sees). A
shell loop appends to a file every second. Each size: a fresh sandbox, then **four migrations in a row**.

Columns: *stopped → healthy* is estimated as (stream time after the source's last live round) + restore + route
switch + first `/healthz` answer; *peer gap* is from the egress side's heartbeat log (no entry = no gap over 100 ms).

**AWS ↔ AWS (m7i.xlarge ↔ m7i.xlarge), 64 MiB/s of writes, 4 migrations per row**

| Memory in use | Total migration | Rounds | Bytes sent | Stopped: last copy + kernel state | Restore | Stopped → healthy | Peer gap |
|---|---|---|---|---|---|---|---|
| idle (agent only) | 0.13-0.15 s | 1 | 23-25 MB | 21-27 ms | 35-38 ms | 82-126 ms | none over 100 ms |
| 256 MiB busy | 0.63-0.72 s | 1 | 0.33 GB | 71-82 ms | 36-42 ms | 133-211 ms | 123-142 ms |
| 512 MiB busy | 1.16-1.17 s | 2 | 0.64 GB | 33-39 ms | 38-43 ms | 97-100 ms | none-113 ms |
| 1 GiB busy | 2.13-2.21 s | 2 | 1.23-1.24 GB | 46-65 ms | 35-42 ms | 115-125 ms | 109-127 ms |
| 1 GiB busy, egress with Linux's default RTO | 2.16-2.17 s | 2 | 1.24-1.25 GB | 40-52 ms | 39-40 ms | 105-119 ms | 113-114 ms |

(In an earlier session the same hosts sent at ~1.1 GB/s and 1 GiB went in one round: 1.1-1.2 s in total, 68-106 ms
final copy, 34-74 ms restore, peer gap 138-164 ms.)

**Before, upstream checkpoint/restore** (2026-10-20, same host type, lazy restore over NFS):

| Memory in use | Checkpoint (pause starts) | Restore returns | Stopped → agent answers | Gap the peer saw |
|---|---|---|---|---|
| idle (agent only) | 59-65 ms | 80-103 ms | 168-195 ms | 133-149 ms, then a 226-228 ms retransmit gap |
| 256 MiB busy | 127-132 ms | 128 ms | 368 ms | 324 ms |
| 512 MiB busy | 213 ms | 124 ms | 624 ms | 402 ms |
| 1 GiB busy | 399-414 ms | 132-200 ms | 942-1039 ms | 601-673 ms |

**AWS ↔ Hetzner (m7i.xlarge ↔ CX33 over WireGuard), 8 MiB/s of writes, 4 migrations per row, egress with the
default RTO**

| Memory in use | Total migration | Rounds | Bytes sent | Last copy + kernel state | Restore (AWS / box) | Stopped → healthy | Peer gap |
|---|---|---|---|---|---|---|---|
| idle (agent only) | 0.33-0.53 s | 1 | 23-25 MB | 17-75 ms | 37-40 / 70-104 ms | 149-190 ms | 148-166 ms, then a 230-240 ms retransmit gap |
| 256 MiB busy | 3.8-5.8 s | 2-3 | 0.34-0.38 GB | 50-91 ms | 38-43 / 84-88 ms | 150-226 ms | 181-225 ms (+233-239 ms toward the box) |
| 1 GiB busy | 12.9-17.0 s | 3-4 | 1.23-1.33 GB | 48-87 ms | 38-39 / 105-106 ms | 141-249 ms | 166-251 ms (+236-240 ms), once 442 ms |

**AWS ↔ Hetzner, 256 MiB busy at 64 MiB/s of writes** (egress with `rto_min 20ms`):

| Direction | Total | Rounds | Bytes sent | Last copy + kernel state | Peer gap |
|---|---|---|---|---|---|
| AWS → box (doesn't converge: the stream ran at ~75-80 MB/s) | 11.9-12.4 s | 7-9 | 0.92-0.93 GB | 421-883 ms | 599-1061 ms |
| box → AWS | 4.9-5.0 s | 4 | 0.45 GB | 122-135 ms | 211-241 ms |

**Survived every migration** (all 34 in the tables above, plus ~20 during development): the same `boot_id`, PIDs and start
times, the counter loop (no gap over 1.5 s), the TCP connection to egress (never closed), and every memory page
(memcheck never reported a stale page). The TCP connection survived 4+ migrations in a row without
`--allow-connected-on-save`. A negative control (the fork with application-write tracking disabled) corrupted the
workload's memory on the first migration: both Python processes crashed.

**Reading the numbers:**
- **Target met:** a busy sandbox with 1 GiB in use is stopped for ~0.1 s (was ~1 s) between AWS hosts, and for
  ~0.15-0.25 s between AWS and the Hetzner box at realistic write rates. That is in the range of the Cloud
  Hypervisor microVM (48-77 ms VMM pause; ~255 ms peer gap), without a VM per sandbox.
- **What the stop consists of:** the last dirty pages and the kernel state (20-90 ms; ~0.4 MB of kernel state for
  the agent sandbox), the restore RPC (35-45 ms on m7i, 70-110 ms on the CX33's shared vCPUs; no memory is loaded),
  the route switch (~12 ms in the prototype, SSH from the controller), then TCP.
- **The peer's gap** is the stop, plus TCP retransmission for the packet in flight at the switch: across the overlay
  the egress side often waits one 200 ms RTO. A per-route `rto_min` (e.g. 20 ms) on the egress side for
  `10.200.0.0/16` removes that; between AWS hosts it made no difference.
- **Write rate vs link:** pre-copy converges only if the sandbox rewrites memory slower than the link sends. Between
  AWS hosts (0.6-1.2 GB/s) a 64 MiB/s writer converges in 1-2 rounds. Over the internet to Hetzner (40-180 MB/s per
  flow, varying) it doesn't; the fork then stops after two rounds without progress, and the stop is the remaining
  dirty set over the link (0.4-0.9 s for 256 MiB at 64 MiB/s). Chat sandboxes are idle most of the time, so the
  scaler should drain idle sandboxes first and retry busy ones later.
- **Total time** is dominated by round 0 (all memory over the link): ~1 s/GiB between AWS hosts, ~10-15 s/GiB to
  Hetzner. Bytes sent ≈ 1.2-1.3 × memory in use at realistic write rates (the agent's own memory included).

## The gVisor fork (DE0CH/gvisor)

- **Branch `main`** (the fork's default branch): upstream master of 2026-10-19 plus:
  - `913bf5cf9` the TCP fix (also alone on branch `upstream/tcp-migration-fix`, ready to send upstream);
  - pre-copy live migration and the restore changes it needed (squashed into one reviewable commit on branch
    `upstream/precopy`, without the fork's CI workflow);
  - `.github/workflows/precopy-release.yml`: on a `precopy-*` tag it runs the changed packages' tests, builds the
    release layout with Bazel (`make copy TARGETS=//:release`, nogo included) and publishes `gvisor.tar.zstd`,
    `runsc`, `containerd-shim-runsc-v1` and `SHA256SUMS` as a GitHub release.
- **Releases:** `precopy-20261020.4` is current (`.3` measured AWS↔AWS). `host-setup.sh` downloads the tarball and
  checks it against `SHA256SUMS`.
- **New runsc commands and flags:**
  - `runsc checkpoint --migrate-to HOST:PORT [--migrate-downtime 100ms] [--migrate-max-rounds 20] ID` (systrap or
    ptrace platform);
  - `runsc restore --migrate-listen ADDR --image-path DIR --background ...` (the receiving side; creates the sandbox
    while the stream arrives; prints the stream's statistics as JSON);
  - `runsc migrate-receive --listen ADDR --image-path DIR` (receive only; restore later from DIR).
  - The image directory must be on tmpfs: its pages file is sparse up to 2^63 bytes, and the restored sandbox keeps
    using `memory.img` from it as its memory.
- **Changes in the sentry** (`pkg/sentry/pgalloc/dirty.go`, `precopy.go`; `pkg/sentry/mm/dirty.go`;
  `pkg/sentry/kernel/precopy.go`; `pkg/sentry/state/precopy`): dirty bitmaps per memory file; write-protection of
  application mappings during rounds; the rounds; the stream; restoring with the received memory file as the
  sandbox's memory; holding back bulk page loading until the kernel is loaded; at most a 2 MiB map unit while a
  memory file loads. Unit tests: `pgalloc` (bitmaps, tracking, a send/save/restore round trip, the received memory
  file, held loading), `state/precopy` (stream round trip, truncated stream), `tcp` (`TestTCPMigrationRepeated`).
- **Known limitations:**
  - Platforms: systrap and ptrace only; KVM maps memory differently and isn't covered by the dirty tracking.
  - io_uring (off by default in gVisor), packet-mmap rings and device proxies (nvproxy, tpuproxy): writes through
    their long-lived mappings are only resent in the final round, or not tracked (devices).
  - A failure during the final stop-and-copy loses the sandbox (the source has stopped); a failure before it leaves
    the sandbox running on the source.
  - Pre-copy can't converge when a sandbox rewrites memory faster than the link sends (see the AWS → Hetzner row);
    it then stops after two rounds without progress, and the stop grows with the remaining dirty set.
  - Upstream review would likely ask to split the change (pgalloc tracking, MM, kernel/stream, runsc, restore
    tweaks) and for the "sticky" handling of internal mappings to be replaced by explicit tracking in their users.

## Security

- gVisor is the boundary: the sandbox's syscalls go to the sentry, which runs under its own seccomp filter, in an
  empty mount namespace, with no host capabilities. The fork doesn't change that; the sentry writes the migration
  stream to a socket that runsc passes in (no new syscalls in the sentry's filter).
- Hardening (unchanged):
  - uid 1000 inside, with passwordless sudo to the sandbox's root (since 2026-10-21, "Installing packages"); that
    root and its capabilities exist only inside gVisor;
  - `--host-uds=none --host-fifo=none`;
  - cgroup limits for CPU, memory and pids (a received sandbox's memory is written from its own cgroup, so it is
    charged there);
  - the overlay upper layer capped at `size=5g`;
  - no host mounts, no secrets in the environment, its own netns with the stateless nft lock.
- **Migration streams** run over WireGuard between hosts (authenticated, encrypted). The receiver accepts one
  connection; sandboxd should start it only for an expected migration and bind it to the overlay address (the
  prototype listens on all addresses, inside one security group).
- **CPU-feature masking** hides host-specific CPU features from applications on Intel hosts; on the AMD box (no
  CPUID faulting) applications see the real CPU, which is a portability, not an isolation, concern.
- **More hardening worth adding:**
  - Hosts: AWS instances with no instance profile, IMDSv2 only with hop limit 1 and the metadata address dropped
    from every sandbox (already the case); SSH off (SSM, or nothing).
  - runsc: a dedicated cgroup parent for all sandboxes with host-wide reserves for sandboxd; user namespaces for the
    gofer where the image allows it.
  - One host pool per instance, so different instances never share a host.

## Cost

**Hetzner (fsn1, monthly, gross incl. VAT; `hcloud server-type describe`, 2026-10-21):**

| Type | vCPU / RAM | EUR/month |
|---|---|---|
| CX33 | 4 shared / 8 GB | 10.19 |
| **CX43 (recommended baseline box)** | 8 shared / 16 GB | **19.19** |
| CX53 | 16 shared / 32 GB | 35.39 |
| CPX42 | 8 shared / 16 GB | 83.39 |
| CCX23 / CCX33 (dedicated) | 4 / 16 GB, 8 / 32 GB | 103.19 / 166.19 |

The CX line had a "limited availability" notice for new servers since 2026-06-26; the CX33 used in the test was
available in fsn1 on 2026-10-20/21.

**AWS (eu-central-1, on-demand; AWS price list published 2026-10-15; per-second billing, 60 s minimum):**

| Item | Price |
|---|---|
| m7i.xlarge (4 vCPU, 16 GiB) | $0.2415/h ($176.30 for a 730-hour month) |
| m7i.large (2, 8) | $0.12075/h |
| m7i.2xlarge (8, 32) | $0.4830/h (2 of them use the whole 16-vCPU quota) |
| gp3 disk | $0.0952 per GB-month (30 GB ≈ $2.86/month) |
| Public IPv4 | $0.005/h |
| Data out to the internet (to Hetzner: drain-back migrations, sandboxes' uploads) | $0.09/GB, first 10 TB/month |
| Data into AWS (from Hetzner; migrations out of the box, downloads) | $0 |
| Same-AZ VM-to-VM | $0 |

**Cost model:**
- **Baseline:** the CX43, EUR 19.19/month, always on. Within YYC's budget; no AWS cost while it suffices.
- **Burst:** $0.2415/h per AWS host while it runs (+ IPv4 and disk); at most 3 at a time ($0.72/h). One host running
  8 h a day on 22 working days costs ~$43/month.
- **Migrations:** Hetzner → AWS is free. **AWS → Hetzner (drain-back) costs $0.09 per GB sent ≈ $0.11-0.12 per GiB
  of sandbox memory at realistic write rates** (1.23-1.33 GB per GiB measured); a sandbox rewriting memory fast can
  cost 3-4× that before the fork gives up and stops it. Draining a full AWS host (~10 GiB in use) back costs ~$1.2.
  AWS ↔ AWS within one AZ is free.
- **Egress from AWS sandboxes** to the egress role on Hetzner: what they upload, also $0.09/GB; downloads are free.

**What the prototypes cost (YYC's accounts):**
- 2026-10-20, shape A/B prototype: $0.75 (AWS).
- 2026-10-20/21, the fork's benchmarks: **~$6.60 AWS + ~EUR 0.19 Hetzner**. AWS: two sessions of 2 × m7i.xlarge +
  t3.small (~10.7 h; ~8.5 h of that idle while the work was paused), gp3 and IPv4 ~$0.27, ~10 GB to Hetzner ~$0.92.
  Hetzner: one CX33 for ~10.7 h. Everything is terminated/deleted, including key pairs and security groups.

## Open questions for Deyao (answered 2026-10-21: TCP fix and pre-copy stay in the fork; CX43 approved; Intel m7i kept with the common feature set; busy sandboxes wait to go idle, and a non-converging move is aborted)

1. **Send the TCP fix upstream?** Branch `upstream/tcp-migration-fix` of DE0CH/gvisor is one commit with a test,
   ready as a PR to google/gvisor. The pre-copy change (`upstream/precopy`) could follow, probably split up and
   discussed on google/gvisor#14390 first.
2. **The baseline box:** CX43 (8 vCPU, 16 GB, EUR 19.19/month) recommended; CX53 (EUR 35.39) if the baseline should
   hold ~2× more sandboxes before AWS starts. Created by Deyao in the yyc project (automation must not create
   Hetzner servers).
3. **CPU vendor:** keep Intel m7i on AWS with the common feature set (tested), or pick an AMD AWS type to match the
   AMD box, which removes the small "AMD-only instruction" risk (not tested)?
4. **Draining busy sandboxes over the internet:** accept a longer stop (~0.5-1 s) for sandboxes that rewrite memory
   at tens of MB/s, or have the scaler wait for them to go idle (the default here)?

## Prototype scripts (`chat/sandboxd/proto/`)

All AWS calls go through `aws.sh`, which uses the YYC account's keys (`YYC_AWS_*`), never the plain `AWS_*`.
`SBX_REGION` defaults to eu-central-1. State such as the SSH key and instance ids goes in `state/`, which is
gitignored. The Hetzner test box is created and deleted by hand (`hcloud` with the yyc project's token) and added to
`state/hosts.txt` as host `c`; no script creates or deletes Hetzner servers.

| Script | What |
|---|---|
| `hosts-up.sh [type] [egress type]` | Two AWS hosts plus an egress/controller VM, tagged `app=yyc-ai-sandbox`; SG open for SSH and WireGuard |
| `overlay-up.sh` | WireGuard mesh between the egress VM, hosts a, b and the Hetzner host c |
| `bringup.sh` | `host-setup.sh` on all hosts (the fork's runsc, the image, nft, tmpfs), the common CPU features, the egress stand-in, then sandbox s1 on host a |
| `sbx.sh` | sandboxd for one host: net / bundle / bundle-dind / run / send / receive-restore / checkpoint / restore / exec / rm |
| `migrate.sh`, `run-test.sh`, `run-matrix.sh` | A migration (`precopy` default; `lazy`/`copy` = upstream stop-and-copy), one measured run, and the matrix (4 migrations per size; `PEER=c` for Hetzner) |
| `docker-test.sh`, `docker-migrate-test.sh` | Docker inside a gVisor sandbox behind the egress lock; migrating it there and back |
| `workload.py`, `start-workload.sh`, `check-workload.sh`, `probe-agent.sh`, `egress-standin.py` | Workload (incl. `memcheck`), checks and the egress stand-in |
| `bench-local.sh`, `bench-sizes.sh` | Upstream checkpoint/restore timelines (the "before" numbers) |
| `vm.sh`, `vm-migrate.sh`, `vm-run-test.sh` | Shape B (not chosen): Cloud Hypervisor microVM |
| `hosts-down.sh` | Terminates everything tagged `app=yyc-ai-sandbox` and prints launch times for the cost record |

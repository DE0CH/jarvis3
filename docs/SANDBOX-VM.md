# Own sandbox hosts (sandbox provider "vm")

Status: design, prototype and a forked gVisor with pre-copy live migration, 2026-10-21. Nothing here is wired into
an instance. This is a third sandbox provider next to `kubernetes` and `e2b` (docs/CHAT.md, "Sandbox providers"). It
runs on our own VMs ("hosts") and live-migrates a running sandbox from one host to another, so the scaler can empty
a host and give it back. The prototype scripts are in `chat/sandboxd/proto/`; the gVisor fork is
[DE0CH/gvisor](https://github.com/DE0CH/gvisor) (branch `main`, releases `precopy-*`).

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
- The Hetzner box itself: Deyao creates it later; this doc recommends a size.

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

## How the existing contract maps

Nothing changes for jarvis-bash, the web role or egress. Their interface is the agent on :7070 with
`X-Jarvis-Exec-Token`, plus egress with the sandbox's token.

- **Lifecycle:** warm on typing, kept while active, released after idle or at max lifetime with files saved. This is
  unchanged and stays owned by `chat/src/web/sandbox.ts`. Migration is invisible to that lifecycle: the sandbox
  keeps its id, IP, tokens, `boot_id`, processes and files. jarvis-bash's `/changes` cursor stays valid because the
  agent process itself moved.
- **No secrets** inside a sandbox. Its environment holds only the proxy URL with its egress token, the mirror
  settings and its exec token, as with `kubernetes`.
- **Egress only through our proxy.** Each sandbox gets nftables rules on its host. It may reach only egress:3128
  (through the overlay) and answer the controller on :7070. It cannot reach the host itself or the cloud metadata
  service. Its connection to egress is the plain HTTP proxy on 3128, without `/wire`: the overlay carries it
  straight to the egress pods, with no NAT on the way.
- **Provider `vm`** (`chat/src/web/sandbox-vm.ts`, to be written) implements `SandboxProvider`:
  - `create(row, egressToken)`: the controller places the sandbox on a host and calls that host's sandboxd
    `POST /sandboxes {id, ip, image, egressToken, execToken, cpu, memory}`. It returns the sandbox id as the name.
  - `waitReady`: returns `{url: "http://<overlay ip>:7070", headers: {}}`. The URL never changes, even after
    migrations.
  - `keepAlive`: a no-op, as in the Kubernetes provider. The janitor owns release.
  - `destroy(name)`: `DELETE /sandboxes/{id}` on whichever host holds the sandbox now.
  - `list()`: the union of every host's `GET /sandboxes`.
- **Host dies:** its sandboxes are gone. The next turn creates a fresh sandbox, gets the existing reset note
  ("files in the workspace are restored; installed packages and background processes from before are gone"), and
  jarvis-bash pushes the workdir again. This is the same path as an E2B sandbox that timed out.


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
    `/exec` calls, which the web role knows from `turns`.
  - Moving AWS → Hetzner is billed as AWS internet egress ($0.09/GB): about the sandbox's memory in use plus what
    it rewrites during the copy (measured: 1.3 GB for 1 GiB at 8 MiB/s of writes). Prefer moving idle sandboxes.
- **Spot (optional):** a spot host's 2-minute interruption notice triggers the same drain. 2 minutes is enough for
  several migrations.
- **Failure:**
  - A host stops answering its heartbeat for 30 s: the controller marks its sandboxes `gone` and terminates the
    instance. The next turn creates a fresh sandbox and gets the existing reset note (files restored; installed
    packages and background processes gone), as with an E2B sandbox that timed out.
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
- **Web to sandbox:** jarvis-bash and the controller reach `<ip>:7070` through the same path (pods → Hetzner network
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

**Flags on both sides:** `--platform=systrap --network=sandbox --overlay2=root:self,size=5g --host-uds=none
--host-fifo=none`. `--network=sandbox` means gVisor's own TCP/IP stack holds every connection, so connections are in
the migrated state. `--allow-connected-on-save` is not needed any more (see "The TCP bug").

**What moves:** processes (same PIDs and start times), files in the overlay upper layer and tmpfs mounts, memory
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
- **Image size:** adding Docker (docker-ce CLI, dockerd, containerd, runc) to the sandbox image adds roughly
  100-150 MB to it; not built yet.

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
  - uid 1000 inside;
  - no capabilities and `noNewPrivileges` (except Docker sandboxes, whose capabilities exist only inside gVisor);
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

## Open questions for Deyao

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

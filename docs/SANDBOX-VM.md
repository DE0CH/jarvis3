# Own sandbox hosts (sandbox provider "vm")

Status: design and prototype, 2026-10-20. Nothing here is wired into an instance. This is a third sandbox provider
next to `kubernetes` and `e2b` (docs/CHAT.md, "Sandbox providers"). It runs on our own cloud VMs ("hosts") and can
live-migrate a running sandbox from one host to another, so the autoscaler can empty a host and give it back.
The prototype scripts are in `chat/sandboxd/proto/`.

Deyao's requirements (2026-10-20):
- Not a Kubernetes cluster. We manage migration ourselves, and Docker-in-Docker doesn't work well there.
- Live migration that copies memory page by page while the sandbox runs, as AWS Nitro does, so the switch costs a few
  hundred ms at most.
- Our own autoscaler. It asks the cloud for a host to scale up. To scale down it consolidates: it migrates the
  sandboxes off the emptiest host, then releases that host.
- Every sandbox is an OCI container (the `chat/sandbox` image), and gVisor (runsc) is its isolation boundary against
  container escape.
- Hosts are ordinary cloud VMs, never bare metal.
- Hosts run in AWS eu-central-1 (Frankfurt, YYC's own AWS account). The rest of YYC AI (web, egress, tools,
  Postgres) stays on Hetzner fsn1.

## Decision summary

| Question | Decision | Why |
|---|---|---|
| Isolation | gVisor (runsc, systrap platform) for every sandbox, in both shapes below | Deyao's requirement. systrap needs no KVM, so it runs on any VM. |
| Shape A: gVisor directly on the host VM, migrated with gVisor's checkpoint/restore | **Works today on any ordinary VM. Meets the switchover target only for sandboxes with up to ~256 MiB of memory in use.** | gVisor's checkpoint is stop-and-copy: the sandbox stays paused while all of its memory is written out (~0.33 ms per MiB, measured). gVisor has no dirty-page tracking, so there is no pre-copy. Restore can be lazy (`--background`), so the pages themselves don't have to cross the network during the pause. |
| Shape B: a microVM per sandbox (Cloud Hypervisor) with gVisor inside it, migrated with the VMM's pre-copy | **Meets the target at 1 GiB of busy memory** (the VMM's measured pause is 48–77 ms) on an ordinary EC2 m7i VM with nested virtualisation, at the normal m7i price | Cloud Hypervisor copies memory while the guest runs and pauses only for the last dirty pages. |
| Recommendation | **B** if the few-hundred-ms switchover must hold for busy sandboxes. **A** if most sandboxes stay small, or until gVisor gains pre-copy (see "Making A pre-copy"). The host agent, controller, networking and scaler below are the same for both. | Deyao decides; the measured numbers are below. |
| Host type | EC2 **m7i.xlarge** (4 vCPU, 16 GiB, $0.2415/h in eu-central-1), or m7i.2xlarge ($0.4830/h) once there are more than ~10 sandboxes. m7i supports nested virtualisation, so it fits both A and B. | Per-second billing (60 s minimum). The VM-to-VM migration copy is free within one AZ. |
| Network | A WireGuard overlay between the hosts and a gateway pair in the Hetzner cluster. Every sandbox has a fixed overlay address (a /32) that moves with it. | A connection from the sandbox to egress is never NATed, so it survives a migration. Moving a sandbox is one AllowedIPs update. |

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
Hetzner fsn1 (YYC AI cluster)                                        AWS eu-central-1 (sandbox hosts)
┌─────────────────────────────────────────────┐                    ┌────────────────────────────────────┐
│ web (controller: placement, scaler,         │                    │ host i: sandboxd                   │
│      migration, provider "vm")              │──HTTPS+mTLS───────▶│   runsc sandboxes (A) or CH VMs (B)│
│ egress :3128 ◀── sandbox IPs, no NAT        │                    │   netns/tap + nft lock per sandbox │
│ sbx-gw ×2: WireGuard to every host,         │◀══ WireGuard ═════▶│   wg0: 10.200.0.0/16 overlay       │
│   one /32 per sandbox → current host        │                    │   ckpt tmpfs, NFS/TCP to peers     │
└─────────────────────────────────────────────┘                    └────────────────────────────────────┘
```

### sandboxd (one per host; the prototype is `sbx.sh` and `vm.sh`)

- **Lifecycle:** it creates, starts, checkpoints, restores and deletes sandboxes, which are runsc containers (A) or
  Cloud Hypervisor VMs (B). It serves `GET/POST/DELETE /sandboxes`, `POST /sandboxes/{id}/send {to}` and
  `POST /sandboxes/{id}/receive`.
- **Image cache:**
  - A: `crane export` of the pinned sandbox image into `/var/lib/sbx/images/<digest>/rootfs`. Every sandbox
    shares it read-only. gVisor's `--overlay2=root:self` keeps each sandbox's writes in its own memory-file-backed
    upper layer, and that layer travels inside the checkpoint.
  - B: the same rootfs as an ext4 disk, built once per image digest and copied byte for byte to every host (the
    guest caches disk blocks, so the copies must be identical). The disk is mounted read-only. `/work`, `$HOME` and
    `/tmp` are tmpfs in guest memory, so they migrate with the VM.
  - Hosts start from a prepared AMI with the image already cached.
- **Networking per sandbox:**
  - A: a network namespace with a veth pair.
  - B: a tap device.
  - In both:
    - The sandbox address is `<ip>/32`, its default route goes via `169.254.1.1`, and the host answers that with
      proxy ARP.
    - The host side has the same MAC (`ee:ee:ee:ee:ee:ee`) on every host, and the sandbox side's MAC is derived from
      its IP. A moved sandbox's ARP cache therefore stays valid.
    - `net.ipv4.neigh.<dev>.proxy_delay=0`. Linux's default of 80 delays every proxy-ARP answer by up to 0.8 s,
      which a restored sandbox measurably paid on its first packets.
    - One nftables table per sandbox, stateless:
      - Out: only `egress:3128`. In: only the controller to `:7070`.
      - Nothing to the host's input chain.
      - Stateless because a connection arriving mid-stream on a new host has no conntrack entry.
- **Migration send/receive:** see "Migration" below. Both ends authenticate with mTLS. In B, Cloud Hypervisor's own
  migration stream takes `tls_dir`.
- **Auth:** the controller calls sandboxd over HTTPS with mutual TLS. Each host's certificate is issued when the
  scaler creates the host, through user data from a short-lived token. Hosts accept migration streams only from
  peers whose certificates come from the same CA.

### Controller (in the web role, behind a leader lock like the janitor)

- **Placement:** a new sandbox goes to the fullest host that still has room, so hosts fill one at a time.
  - Memory counts by the sandbox limit (`sandbox.memory`), plus headroom on each host for one incoming migration.
  - CPU is overcommitted (default 3×) because chat sandboxes are idle most of the time.
- **Overlay addresses:** a sandbox gets a free /32 from `10.200.0.0/16`, stored in a new `sandboxes.host` /
  `sandboxes.ip` column.
- **Scale up:** when placement finds no room, or room falls under one sandbox, the controller asks EC2 for a host
  (`RunInstances` from the AMI, tagged `app=yyc-ai-sandbox`).
  - Booting takes ~30–40 s. The prototype's VMs were reachable over SSH in ~30 s.
  - That is too slow to happen while someone types, so the scaler keeps one host's worth of free room
    (`sandbox.vm.spareSlots`).
- **Scale down (defragmentation):**
  - When the sandboxes on the emptiest host fit in the free room of the others, the controller migrates them away
    one at a time, then terminates the empty host. EC2 bills per second, so a host released early saves money at
    once.
  - It never drains during a running turn's bash call. It waits until the sandbox's agent is between `/exec` calls,
    which the web role knows from `turns`.
- **Spot (optional):** a spot host's 2-minute interruption notice (EventBridge or instance metadata) triggers the
  same drain. 2 minutes is enough for several migrations. Spot m7i in eu-central-1 is about 55–60 % cheaper; the
  exact price changes daily.
- **Failure:**
  - A host stops answering its heartbeat for 30 s: the controller marks its sandboxes `gone` and terminates the
    instance. The next turn takes the reset path.
  - A migration fails before the target resumes: the source keeps the sandbox. gVisor needs `--leave-running` or
    a restore from the same image on the source; Cloud Hypervisor resumes the source by itself.
  - A migration fails after the target resumed: the source is deleted, and the target is the sandbox.

### Cross-cloud network (hosts on AWS, YYC AI on Hetzner)

- **sbx-gw:** two small Hetzner Cloud VMs in the YYC project's private network.
  - Each runs WireGuard to every host.
  - The Hetzner network has a route `10.200.0.0/16 → sbx-gw`.
  - Each sandbox's /32 is in the AllowedIPs of the WireGuard peer of the host that holds it. Moving a sandbox is
    `wg set wg0 peer <new host> allowed-ips <ip>/32,...`. WireGuard removes the /32 from the old peer in the same
    step, on both gateways. In the prototype this was one `ip route replace`.
  - Hetzner rule: the yyc project's token must not create or delete servers from automation. So Deyao creates the
    two gateway VMs once, or they live in a separate runner project. They are static and not scaled.
- **Web to sandbox:** jarvis-bash and the controller reach `<ip>:7070` through the same overlay. Their path is
  pods → node → Hetzner network route → sbx-gw → WireGuard → host → sandbox.
  - The sandbox's own nftables admit only the controller's addresses (the sbx-gw addresses after SNAT, or the
    pods' range if the gateway doesn't SNAT).
  - The exec token is still required.
- **Sandbox to egress:** the sandbox connects to egress:3128 by its overlay address, so the connection survives a
  migration. Egress additionally checks that the source IP belongs to the token's sandbox.
- **Latency:** fsn1 to Frankfurt is a few ms; to be measured once sbx-gw exists.

**Cost of the egress path:**
- Traffic from AWS to Hetzner is AWS internet egress at $0.09/GB (first 10 TB/month, eu-central-1; AWS price list
  `AWSDataTransfer`). Traffic into AWS is free.
- Package downloads therefore cost AWS nothing. What sandboxes upload is billed, and that is small.

**Alternative (no WireGuard):** the agent's existing `/wire` WebSocket to egress (the E2B path). Its connection to
egress originates in the sandbox and is NATed by the host, so it breaks on migration. The agent would have to
reconnect, and every connection open at that moment would be cut. The overlay keeps them, which is the point of
migrating.

## Migration

### Shape A, gVisor (prototype `migrate.sh`)

1. The target creates the same netns, veth, address, MACs and nft table, plus the same bundle (same rootfs digest,
   same runsc flags).
2. Pause starts: the source runs `runsc checkpoint` into a tmpfs (`/run/sbx/ckpt`, a memory copy at ~3 GB/s).
3. The target runs `runsc restore --background` with the image read over NFS from the source's tmpfs. Kernel
   state loads at once, and pages fault in on demand, then fill in the background.
   - The route must move only after restore. Before that, the target netns still has the address with no gVisor
     behind it, and Linux would answer the moved connections with RST.
4. The controller moves the /32. Pause ends when the restored sandbox runs.
5. When the target has read every page (the source's NFS read counter holds still), the source deletes its copy.

**Flags that must match on both sides:**
`--platform=systrap --network=sandbox --overlay2=root:self,size=5g --host-uds=none --host-fifo=none --allow-connected-on-save`.
`--network=sandbox` means gVisor's own TCP/IP stack holds every connection, so connections are in the checkpoint.

**`--allow-connected-on-save` is required.** Without it, established TCP connections survive the sandbox's first
migration but are aborted (`ECONNABORTED` inside, nothing sent to the peer) on every later one.
- Cause (gVisor release-20261012.0): `stack.Stack.allowLiveTCPMigration` is `state:"nosave"`, and nothing sets it
  again after a restore (`pkg/tcpip/stack/stack.go`).
- This is a one-line upstream fix worth sending.

### Shape B, Cloud Hypervisor microVM (prototype `vm.sh`, `vm-migrate.sh`)

1. The target creates the tap and nft table, then starts an empty `cloud-hypervisor` and
   `ch-remote receive-migration receiver_url=tcp:0.0.0.0:6000`.
2. The source runs `ch-remote send-migration destination_url=tcp:<dst>:6000,downtime_ms=100,connections=4`.
   - Cloud Hypervisor v54 runs pre-copy: it copies all guest RAM while the VM runs, then repeats for dirty pages
     until the estimated final round fits `downtime_ms`.
   - Then it pauses, sends the rest plus device state, and resumes on the target.
   - `postcopy` and TLS (`tls_dir`) are also available.
3. When the target's `receive-migration` returns, the VM runs there. The controller moves the /32.

`send-migration` returns at once, and the route must not move before the target resumes.

In B the gVisor layer runs inside the guest (runsc in the VM, systrap). The prototype measured migration with the
agent directly in the guest; running runsc inside the guest is the A setup, unchanged.

## Measured (2026-10-20)

**Setup:**
- Hosts: two EC2 m7i.xlarge (4 vCPU, 16 GiB, nested virtualisation on) in one eu-central-1 subnet, Ubuntu 24.04
  (kernel 7.0).
- A third VM (t3.small) was the egress stand-in and the controller.
- Software: gVisor release-20261012.0, Cloud Hypervisor v54.0 with CH's 7.2.8 guest kernel.
- Sandbox image: `ghcr.io/de0ch/jarvis3-sandbox:288ec849eab9`.

**Workload:**
- `workload.py mem N 64` holds an N MiB buffer and dirties 64 MiB/s of random 4 KiB pages.
- `workload.py heart` keeps one TCP connection through the egress proxy and echoes a line every 20 ms. The egress
  side logs every gap: the outage a peer sees.
- A background shell loop appends to a file every second.

Re-run with `run-matrix.sh "0 256 512 1024"` and `vm-run-test.sh a b`.

**Shape A, gVisor checkpoint/restore, A→B, lazy restore over NFS**

| Memory in use | Checkpoint (pause starts) | Restore returns | Stopped → agent answers | Gap the peer saw | Image |
|---|---|---|---|---|---|
| idle (agent only) | 59–65 ms | 80–103 ms | 168–195 ms | 133–149 ms, then a 226–228 ms retransmit gap | 21 MB |
| 256 MiB busy | 127–132 ms | 128 ms | 368 ms | 324 ms | 295 MB |
| 512 MiB busy | 213 ms | 124 ms | 624 ms | 402 ms | 564 MB |
| 1 GiB busy (3 runs) | 399–414 ms | 132–200 ms | 942–1039 ms | 601–673 ms | 1.10 GB |

- After lazy restore, the target finished loading pages in the background 0.07 s (idle) to 2.5 s (1 GiB) later.
- With stop-and-copy instead (copy the whole image, then restore), 1 GiB took 1614–1646 ms from stop to healthy, and
  the peer saw a gap of ~1.6 s.
- **Where the pause goes** (sentry debug timeline, 1 GiB):
  - Save: zero-page scan 55 ms, kernel state 77 ms, page writes 361 ms at 3.0 GB/s.
  - Restore: kernel state load ~340 ms locally. It runs alongside the page loader and ends when the loader ends.
    From NFS, restore returns after 110–200 ms and pages keep loading after the sandbox runs.
  - The pause therefore grows with memory in use: about 60 ms + 0.33 ms per MiB to save, plus ~100–130 ms to restore.
- **Survived every migration:** the same `boot_id`, PIDs, elapsed times and the background loop (one tick late), and
  the TCP connection to egress, across 4+ consecutive migrations.
- **Egress lock (inside a gVisor sandbox):** direct internet, the host, other hosts, other sandboxes and the EC2
  metadata service are all blocked. pypi.org through the proxy works. No capabilities, uid 1000.
- **Cold start** (`runsc run` until the agent answers, from the controller): 856–869 ms, mostly Node.js starting the
  agent. Restoring a pre-booted template checkpoint (an idle checkpoint restores in ~100 ms) is the way to start in
  well under a second.

**Shape B, Cloud Hypervisor pre-copy (2 vCPU, 2 GiB guest, same workload with 1 GiB busy)**

| Run | Total migration | Pre-copy rounds | VMM pause (CH's own figure) | Gap the peer saw | Bytes sent |
|---|---|---|---|---|---|
| A→B | 1.5 s | 1 + final | 64 ms | 254 ms | — |
| B→A | 1.5 s | 1 + final | 71–74 ms | 251 ms | — |
| A→B | 1.5 s | 1 + final | 67 ms | 256 ms | — |
| B→A, with an extra 256 MiB dirtied at 256 MiB/s | 1.7 s | 2 + final | 48 ms | 255 ms | 2.48 GB |

- The gap the peer sees is the pause plus TCP's ~200 ms minimum retransmit timer: the packet in flight at the switch
  is lost and resent. In A, the second gap after small migrations has the same cause.
- Processes, files and the TCP connection survived every migration.
- Cold boot to agent answering: 834–855 ms (kernel + init + Node.js), the same as gVisor.

**Docker inside gVisor (shape A)** (`docker-test.sh`): a sandbox from `docker:29-dind`, behind the same egress lock.
- Settings: runsc `--net-raw --allow-packet-socket-write`, in-sandbox capabilities, tmpfs `/var/lib/docker`, dockerd
  with `iptables: false, bridge: none`, inner containers on `--network=host`
  (gvisor.dev/docs/tutorials/docker-in-gvisor).
- Results:
  - pulled through the egress proxy, then ran `docker run hello-world` and a `docker build`;
  - live-migrated the Docker sandbox to the other host (68 MB image) with dockerd, its pulled and built images
    intact;
  - ran both containers again after the move.
- The capabilities are gVisor's own: the sentry still runs with none on the host.
- To ship it, the sandbox image needs Docker. Docker-enabled sandboxes need these flags, and a Docker pull is
  egress traffic like any other.

## Making A pre-copy (what's missing in gVisor)

Upstream (master 760b80785dc5, 2026-10-19) has no dirty-page tracking, no incremental checkpoint and no live
migration:
- `Kernel.SaveTo` pauses the kernel for the whole `MemoryFile.SaveTo`.
- Issue google/gvisor#14390 proposes pre-copy and copy-on-write, with no maintainer answer.
- PR #14228 brings the pause for the filestore part to 63–68 ms with FICLONE.

A contribution would need:
1. **Dirty tracking in the sentry:** write-protect the application mappings of the main MemoryFile through
   `platform.AddressSpace` (works on systrap), and record pages on write faults and on `MapInternal` / `DataFD`
   writes. Rounds force 4 KiB mappings.
2. **An iterative `SaveTo`:** round 0 copies every page while the sandbox runs, each later round copies the dirty
   set, and the final pause copies the remainder plus kernel state.
3. **A destination that merges rounds into one memory file.** `pages.img` is written in segment order, not file
   order, so this needs a small pages-file composer, or a custom stateio "migration gofer". The latter fits the
   existing out-of-process checkpoint-I/O hook (`pkg/sentry/state/stateipc`, today GCS only).

**Estimate:** weeks of upstream-quality work in the sentry's memory management, plus review by gVisor maintainers.
With it, A's 1 GiB pause would fall to roughly kernel save (~80 ms) + a small final dirty set + restore (~100 ms),
which is comparable to B.

## Security

**Both shapes:**
- gVisor is the boundary: the sandbox's syscalls go to the sentry, which runs under its own seccomp filter, in an
  empty mount namespace, with no host capabilities.
- Hardening:
  - uid 1000 inside;
  - no capabilities and `noNewPrivileges` (except Docker sandboxes, whose capabilities exist only inside gVisor);
  - `--host-uds=none --host-fifo=none`;
  - cgroup limits for CPU, memory and pids;
  - the overlay upper layer capped at `size=5g`;
  - no host mounts (the rootfs is a read-only shared directory or disk, and everything writable lives in the
    sandbox's own memory);
  - no secrets in the environment;
  - its own netns/tap, with the stateless nft lock.
- **More hardening worth adding:**
  - **Hosts:**
    - Instances with no instance profile.
    - IMDSv2 only with hop limit 1, and the metadata address dropped from every sandbox (already the case).
    - SSH off on hosts (SSM, or nothing).
  - **runsc:**
    - A dedicated cgroup parent for all sandboxes, with host-wide reserves for sandboxd.
    - User namespaces for the gofer (rootless runsc) where the image allows it.
    - runsc's experimental `--network-proxy-path` to keep packets out of the host netns entirely (later).
  - **Isolation between staff:** one host pool per instance, so different instances never share a host.
- **B adds a second boundary** (the KVM microVM, with gVisor inside it): one more escape stands between a sandbox
  and the host, at the cost of nested-virtualisation overhead.
- **Controller to host:** mTLS. Host to host migration: mTLS (B with Cloud Hypervisor's `tls_dir`; A by serving the
  checkpoint over the authenticated sandboxd API instead of plain NFS). The prototype used plain NFS and plain TCP
  inside one security group.

## Cost (eu-central-1, on-demand, Linux)

Sources:
- AWS price list, published 2026-10-15
  (`https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/EU%20(Frankfurt)/Linux/index.json`).
- gp3 from `aws pricing get-products`.
- Billing is per second with a 60 s minimum. A public IPv4 address costs $0.005/h.

| Item | Price |
|---|---|
| m7i.large (2 vCPU, 8 GiB) | $0.12075/h |
| m7i.xlarge (4, 16) | $0.2415/h ($176.30 for a 730-hour month) |
| m7i.2xlarge (8, 32) | $0.4830/h |
| m7i-flex.xlarge / .2xlarge | $0.22942 / $0.45884 /h (flex: not for sustained CPU) |
| m8i.xlarge / .2xlarge | $0.25358 / $0.50716 /h |
| m7g.xlarge / .2xlarge (Graviton; A only, no nested virtualisation) | $0.1955 / $0.3910 /h |
| c7i.2xlarge (8, 16) | $0.4074/h |
| r7i.2xlarge (8, 64) | $0.6384/h |
| gp3 disk | $0.0952 per GB-month (30 GB ≈ $2.86/month) |
| Data out to the internet (to Hetzner) | $0.09/GB for the first 10 TB/month |
| Same-AZ VM-to-VM (migration) | $0 |
| Bare metal, for comparison (ruled out) | m7i.metal-24xl $5.796/h |

**Per sandbox:** at 1 GiB per sandbox and the default limit of 6 live sandboxes per instance, one m7i.xlarge holds
all six with room for a migration. That is ~$0.04/h per sandbox slot when full.

**Fixed cost:** keeping one host always on is $176/month plus disk and IPv4 (~$183). **That is over YYC's
$40/month AWS budget**.

**Ways down:**
- Scale to zero outside working hours, at the price of a ~40 s first start when nobody is warm.
- m7i.large ($88/month always on).
- Spot, which live migration makes safe.
- Shape A on Hetzner Cloud hosts (no KVM needed). The EU CX/CPX lines cost a fraction of EC2, but Hetzner has an
  open "limited availability" notice for new servers since 2026-06-26, and the automation rule above.

**What the prototype cost (YYC's AWS account): $0.75.**
- **Breakdown:**
  - compute: $0.713;
  - gp3: $0.016;
  - public IPv4: $0.024;
  - data transfer: negligible (the migration copies stayed inside one AZ).
- **Instances:**
  - Singapore before the region decision: 4 × m7i.large and 2 × t3.small, ~13–15 min each.
  - Frankfurt:
    - 3 × m7i.xlarge for 41 min. One of these was an orphan from a partly failed launch, which `hosts-up.sh` now
      cleans up.
    - 2 × m7i.large for 17 min, idle while the region was being verified.
    - 1 × m7i.2xlarge for 10 s, billed as 60 s.
    - t3.small for 42 min.
- Everything is terminated, and the key pairs and security groups are deleted.

## Open questions for Deyao

1. **Shape:**
   - B: microVM + gVisor. It meets the few-hundred-ms switchover at 1 GiB busy today (VMM pause 48–77 ms; peer gap
     ~255 ms including TCP's retransmit).
   - A: gVisor directly on the VM. It meets the target up to ~256 MiB in use, and 1 GiB busy pauses 0.6–1.0 s.
   - Or A now, plus the upstream pre-copy contribution.
2. **Budget:** an always-on m7i.xlarge is $176.30/month, over the $40/month YYC AWS budget. Raise the budget, scale
   to zero at night, use m7i.large ($88.15/month), or use spot?
3. **vCPU quota:** YYC's eu-central-1 limit for standard instances is 16 vCPUs. Launching two m7i.2xlarge plus a
   t3.small (18 vCPUs) was refused. The scaler needs a quota increase (Service Quotas `L-1216C47A`).
4. **sbx-gw:** two small Hetzner VMs for WireGuard (e.g. CPX22-class) in the yyc project, created once by Deyao or
   in the runner project. Which one?
5. **Docker in sandboxes:** ship Docker in the sandbox image (in-sandbox root and capabilities, gVisor-contained) for
   every conversation, or only on request?

## Prototype scripts (`chat/sandboxd/proto/`)

All AWS calls go through `aws.sh`, which uses the YYC account's keys (`YYC_AWS_*`), never the plain `AWS_*`.
`SBX_REGION` defaults to eu-central-1. State such as the SSH key and instance ids goes in `state/`, which is
gitignored.

| Script | What |
|---|---|
| `hosts-up.sh [type] [egress type]` (`NESTED=1` for /dev/kvm) | Two hosts plus an egress/controller VM, tagged `app=yyc-ai-sandbox` |
| `bringup.sh` | `host-setup.sh` on both hosts (runsc, the image, nft, the NFS export, the checkpoint tmpfs), the egress stand-in, then sandbox s1 on host A |
| `sbx.sh` | sandboxd for shape A: net / bundle / run / checkpoint / restore / exec / rm |
| `migrate.sh`, `run-test.sh`, `run-matrix.sh` | A migration, one measured run, and the size matrix |
| `bench-local.sh`, `bench-sizes.sh` | In-place checkpoint + restore with gVisor's debug timelines, to break the pause down |
| `docker-test.sh` | Docker inside a gVisor sandbox behind the egress lock |
| `vm.sh`, `vm-migrate.sh`, `vm-run-test.sh` | Shape B: Cloud Hypervisor microVM setup, run, live migration and a measured run |
| `workload.py`, `start-workload.sh`, `check-workload.sh`, `probe-agent.sh`, `egress-standin.py` | Workload, checks and the egress stand-in |
| `hosts-down.sh` | Terminates everything tagged `app=yyc-ai-sandbox` and prints launch times for the cost record |

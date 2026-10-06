# Broker networking

Transport reference: [Node TLS pre-shared keys](https://nodejs.org/api/tls.html#pre-shared-keys).

This first version connects two explicitly paired brokers. Networking is off by default. It uses Node's built-in `tls`, `crypto` and `dgram` modules and the existing Zod dependency. It does not launch remote agents or execute received files.

## Configuration and pairing

Run `agent-bridge connect` with a hosting session running on each PC. The guided flow saves settings atomically while preserving other keys, reviews firewall commands, and reloads the elected broker. Choose create on one PC and connect on the other; use discovery or a manual LAN address and the secret code. Verification lists remote peers and sends a broker echo round trip without messaging an agent. Windows firewall rules require separate explicit confirmation and UAC; macOS/Linux show commands for manual review. `--yes` only confirms config writes, never firewall changes.

Keep the same top-level configuration on every local agent that can host a broker. Per-agent and environment overrides must match before future broker elections. Old brokers require updating and restarting all local hosting sessions. Manual config edits take effect when the elected broker starts:

```json
{
  "network": {
    "enabled": true,
    "name": "mac-studio",
    "bind": "0.0.0.0",
    "port": 48148,
    "discovery": true
  }
}
```

Names must be unique among paired instances and use letters, digits, dots, underscores or hyphens (maximum 64 characters, starting with a letter or digit). The default name is the hostname; the default bind address is `127.0.0.1`. Set a LAN interface address or `0.0.0.0` deliberately for cross-PC use. Allow TCP 48148 and, for discovery, UDP 48149 in your firewall. TCP ports may be changed; `0` requests an ephemeral test port. Discovery is independently opt-in.

Manual fallback using the bundled CLI of a running agent-bridge broker:

```sh
agent-bridge network
agent-bridge pair
# Copy the printed code securely to the other PC, then:
agent-bridge link 192.168.1.20:48148 <code>
# Equivalent on the receiving PC:
agent-bridge pair <code> 192.168.1.20:48148
agent-bridge unlink <remote-instance-id>
```

`node <plugin>/dist/cli.mjs` also runs these commands. The CLI authenticates to the local pipe and never creates a network listener itself. `pair` creates a random 256-bit invitation that expires after ten minutes. It prints the entire secret code; share it through a trusted channel and keep it out of shared logs and shell histories. The first authenticated remote identity consumes the invitation. It cannot pair another instance afterward. A pairing persists until revoked. `network` and the MCP `network_status` tool expose public identities, discovery hints and connection state, never pairing keys.

Secrets and instance identity live in `~/.agent-bridge/network/keys.json`, separate from `config.json` and the local pipe token. The directory and files use Unix modes 0700/0600; Windows removes inherited ACL grants and grants the current account SID. Permission failures prevent networking from starting. Writes use a protected temporary file and rename. Only the elected broker writes the store. Its persistent random identity key supplies a SHA-256 fingerprint for discovery and pairing; it is not a signing certificate. Trust comes from possession of the invitation secret and the pinned instance identity, not from the unauthenticated discovery fingerprint.

The initiating side stores the explicitly supplied host and port. It reconnects only that stored endpoint, every two seconds while disconnected. The receiving side accepts its already paired key. Neither side takes connection addresses from discovery. To change an instance's name, identity, key or address, unlink it and pair again; unlink on both PCs to remove both copies of the secret. An interrupted first pairing can leave the receiving side paired before the initiating side saves its state; inspect `network` and unlink before retrying.

## Dashboard JSON API

The dashboard remains loopback-only. All endpoints require its per-launch HttpOnly cookie; every POST also requires `x-agent-bridge: 1` and JSON. Codes appear only in the explicit pairing response, never status or errors.

| Method and path | Request | Response |
| --- | --- | --- |
| GET `/api/network` | None | `enabled`, `config` (name/bind/port/discovery/enabled), optional `identity` and listening `port`, `discovered`, `paired` |
| POST `/api/network/configure` | `confirm: true` and any network config fields | Status after atomic save and live reload; omitted fields keep current settings |
| POST `/api/network/pair` | `{}` | Secret `code`, `expiresAt` in epoch milliseconds |
| POST `/api/network/link` | `address` as host:port, `code` | Public remote `id`, `name`, `fingerprint` |
| POST `/api/network/unlink` | `id` | `removed` |
| POST `/api/network/verify` | `id` | Remote `peers` and echo `roundTripMs` |
| POST `/api/network/firewall` | `{}` to inspect; `apply: true, confirm: true` for Windows UAC | `plan` (platform, commands, explanation), `status` (allowed/unknown, detail) |

Discovered entries include `id`, `name`, `fingerprint`, `host`, `port`, `seenAt`. Paired entries include public identity, `connected`, and optional `health: { lastVerifiedAt, roundTripMs }` from the last successful verification; consult `connected` before interpreting old health. A failed reload leaves the settings saved but networking unavailable; the local broker stays available for retry. Invalid requests return 400, missing authentication/header/allowed Host return 403, unavailable network actions return 409, and unknown paths return 404.

## Threat model

Protect application traffic against an untrusted LAN, passive listeners, altered traffic, replay of TLS records, and instances without a pairing secret. TLS 1.3 with `TLS_AES_128_GCM_SHA256` and pre-shared keys provides mutual proof of key possession and encrypted application records. OpenSSL handles cryptographic negotiation; agent-bridge does not implement a custom cipher or handshake. There is no plaintext application transport or older TLS fallback. A client rejects certificate-based handshakes even though ordinary certificate verification is disabled for the certificate-free PSK mode. Each side checks the remote instance id, name and fingerprint inside TLS against its pairing record (the invitation holder is pinned on first use). The local pipe token never crosses the network.

Pairing trusts the remote broker to represent its sessions and job runners. A compromised paired PC, a stolen code, or a process with access to that user's keys can impersonate its agents and deliver arbitrary messages or bounded file bundles. This version does not provide per-agent authorization, identity signatures, protection from a malicious local account owner, internet rendezvous, or an external security audit. Agent messages remain colleague requests, not owner instructions. Network listeners are not a substitute for host firewall rules. Do not expose the service to the public internet.

## Discovery

IPv4 UDP multicast uses group `239.255.48.49`, port 48149, TTL 1. Announcements every five seconds contain a service marker, protocol version, instance id, human name, TCP port and identity fingerprint. These public discovery hints are **unencrypted and unauthenticated**; agent lists, messages, file contents and pairing secrets are never included. The source IP comes from the datagram, not its JSON payload. Discovery never pairs or connects.

Hints expire after twenty seconds. Invalid, self and oversized datagrams are ignored; the cache holds at most 128 instances and each datagram is limited to 1024 bytes. Multicast is sensitive to firewalls, VPNs, Wi-Fi isolation and interface routing; a manual address works without discovery. Instances are visible through CLI `network` and MCP `network_status`. Authenticated dashboard JSON endpoints expose discovery and paired health, expiring code creation, link verification and unlink controls. Tests use unicast UDP on `127.0.0.1`; real multicast and multi-interface behavior remain owner validation.

## Protocol and routing

Network protocol 1 is separate from the unchanged local pipe protocol. After TLS, both sides exchange a validated `hello` with their pinned identity and a local peer snapshot. Snapshots refresh every two seconds and before a send. They include job runners, but never peers learned from other network links: routing is direct, with no transitive federation.

Encrypted newline-delimited JSON records carry `hello`, `peers`, `send`, `files`, a bounded `echo` health request and correlated `result` responses. Echo support is advertised in hello; verification of an older broker reports that it needs updating without dropping its link. Every record is checked with bounded schemas. Connections require a hello within five seconds. Frames are limited to two MiB; snapshots hold at most 256 peers; the store caps paired instances and invitations at 16 each, with 16 inbound TCP connections and 64 outstanding requests per link. Slow writers are disconnected rather than accumulating unlimited output.

Remote peers appear in `peers` as `mac-studio/claude-app` or `mac-studio/codex-job-12345678`. Their ids are also namespaced. Send to that address with the existing `send` tool; replies use the prefixed sender name. Agent-kind targets and `*` retain their local meaning. Remote sends must name a paired instance explicitly, preventing accidental cross-PC broadcasts. Senders must be present in their broker's current snapshot. A job runner speaks as its job's agent kind.

Message ids, conversations, reply ids and hop counts survive routing. The receiver persists messages in its existing broker database before acknowledging them and queues for an offline named recipient while the link is connected. The sender retains the returned message for reply tracking. Local in-flight dedupe keys also prevent concurrent retries from delivering twice. Once disconnected, a remote send fails; there is no durable outgoing spool across links. A five-second timeout can mean delivery happened without its acknowledgement reaching the sender. Cross-PC exactly-once delivery after a lost acknowledgement is not guaranteed.

This lane implements broker transport for supervisor and job-runner messages. Forwarding ordinary messages between a running subagent and its runner is the sibling AB-51 change; it must be integrated before claiming interactive subagent-to-subagent acceptance.

## Files and folders

`send_files(to, paths)` reads files or directory trees relative to the sending session's cwd (or absolute paths) and delivers them to an online local session or an online peer on a paired instance. It uses the same TLS link remotely. The receiver publishes a fresh `~/.agent-bridge/inbox/<transfer-id>` directory and sends the target peer a normal message with the inbox path. Nothing is written into a workspace or executed automatically.

The first version is a single in-memory manifest: at most one MiB of decoded file contents, 128 total entries including directories, and 16 path components. It preserves nested and empty directories. Each file has a SHA-256 checksum; the entire manifest and total size are validated before writing. File contents use canonical base64 inside the encrypted record. Symlinks, junctions, device files, absolute destination paths, traversal, backslashes, Windows alternate streams/device names, trailing dots/spaces, case aliases, duplicate paths and files used as parents are rejected. The inbox cannot itself be a symlink. Files use exclusive creation inside a new staging directory, then the whole directory is renamed into place. Existing transfers are never overwritten; failed writes remove staging.

The tool returns transfer id, inbox path, file count and decoded byte count. Local transfers require the standard configured broker home, even with networking disabled. Remote files require the recipient to be online; messages can queue, but files do not. There is no streaming, resumption, compression, executable-bit preservation, transfer UI, per-peer cumulative storage quota or automatic inbox cleanup. A trusted paired sender can fill disk through repeated bundles; owners manage the inbox. Large files are intentionally rejected until a streaming protocol is added.

## Validation boundary

Tests run two in-process brokers and TLS/UDP instances on `127.0.0.1`, including a ciphertext-observing TCP proxy. They cover pairing rejection, persistence, reconnection, revocation, remote names and ids, offline message delivery, reply hops, sender validation, passive discovery, folder transfer, size limits, checksums and unsafe paths. Builds and the full Vitest suite validate local integration. They do not prove Windows-to-macOS operation, actual LAN multicast discovery, firewall setup, OS clipboard behavior, dashboard presentation or the sibling subagent forwarding lane.

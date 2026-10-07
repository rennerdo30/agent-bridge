---
title: "LAN discovery diagnostics"
---

Discovery is an untrusted hint, never permission to pair. The UDP listener binds
to 0.0.0.0:48149. Every suitable IPv4 interface gets a sender bound to its own
address, directed broadcasts for its subnet, and announcements to the existing
239.255.48.49 multicast group with TTL 1. The listener joins that group explicitly
on each interface. Multicast failure preserves directed broadcast. The interface
list is refreshed every five seconds; loopback, link-local, known virtual and
tunnel adapters, and subnets without broadcast addresses are skipped.

This follows Node's documented interface selection: omitting the interface in
addMembership joins only the OS-selected interface.
See [Node dgram](https://nodejs.org/api/dgram.html).
The custom group and port are agent-bridge discovery, not the mDNS protocol.

## Status contract

The broker networkStatus response includes discoveryDiagnostics when discovery
is enabled. Both agent-bridge network and authenticated GET /api/network expose
it unchanged:

- bind, port, multicastGroup, multicastTTL: listener and multicast settings.
- interfaces: name, address, netmask, broadcast, announcing, multicast,
  lastSentAt for each active sender. announcing means sends are attempted;
  multicast means interface selection and membership succeeded.
- skippedInterfaces: name, address, reason.
- lastSentAt: last successful local UDP send callback, not remote delivery proof.
- lastReceivedAt: last valid announcement from another instance.
- lastError: null or {at, message}, retained after subsequent successes.

Times are epoch milliseconds; unset times are null. Older brokers and disabled
discovery omit discoveryDiagnostics.

The CLI and GET endpoint also add networkProfiles (interfaceAlias,
interfaceIndex, category) and networkProfileHint (string or null). A read-only
Windows profile query is cached for 30 seconds. A Public profile gives an explicit
hint that Private firewall rules do not apply. Query failure gives an unknown
hint; other operating systems return an empty list and null hint.
The dashboard should display a non-null hint and discovery errors, and show the
announcing interfaces and send/receive ages.

Windows applies rules by profile; local matching rules are not proof that traffic
can cross the LAN. See [Microsoft firewall guidance](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure).

## Owner verification

No host firewall, network profile, config, pairing, or log files were changed by
the diagnosis. After the owner installs this build and restarts the hosting
broker on both PCs:

1. On Windows run node plugins/claude/dist/cli.mjs network. Expect Ethernet 2 /
   192.168.1.235 with broadcast 192.168.1.255 and recent lastSentAt; WSL/Hyper-V
   adapters should appear under skippedInterfaces. Check lastError.
2. On the Mac run the same command from its installation. Verify enabled and
   discovery are true, a physical LAN address is selected, and lastSentAt advances.
   Confirm the Mac is on the same subnet/VLAN, with no Wi-Fi client isolation.
3. On each PC expect the other under discovered and lastReceivedAt advancing
   within two announcement intervals. Discovery alone does not prove pairing.
   Check the existing paired Mac connects and verify a real cross-PC message.
4. On the Mac inspect System Settings > Network > Firewall > Options for the
   actual Node executable. Read-only checks:

       /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
       /usr/libexec/ApplicationFirewall/socketfilterfw --listapps
       lsof -nP -iTCP:48148 -sTCP:LISTEN
       lsof -nP -iUDP:48149
       nc -vz 192.168.1.235 48148

   If needed, the owner can capture packets on the physical LAN adapter:

       sudo tcpdump -ni en0 'udp port 48149'

   Replace en0 with the actual adapter. Confirm packets go both ways to the
   subnet broadcast or multicast address. TCP success does not prove UDP access.

Windows owner commands (review in an elevated PowerShell; do not apply unless
needed on the trusted LAN):

    Get-NetConnectionProfile
    Set-NetConnectionProfile -InterfaceIndex 10 -NetworkCategory Private
    New-NetFirewallRule -DisplayName 'agent-bridge TCP 48148' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 48148 -Profile Private -RemoteAddress LocalSubnet
    New-NetFirewallRule -DisplayName 'agent-bridge UDP 48149' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 48149 -Profile Private -RemoteAddress LocalSubnet

Index 10 was Ethernet 2 in the read-only snapshot; recheck before changing it.
The snapshot already had a Private LAN and both exact allow rules, so repeating
these mutations is unnecessary unless current policy differs.

The snapshot's netsh interface ipv4 show joins also showed 239.255.48.49 on
Ethernet 2, and the broker's UDP listener was already on 0.0.0.0:48149.
Default-interface selection is a product weakness, but a wrong receive interface
was not established as this outage's cause. No discovery errors were found in
the inspected broker logs. Mac readiness, multicast filtering, client isolation,
and actual cross-PC packet delivery remain owner checks.

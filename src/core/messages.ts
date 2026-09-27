export const en = {
  "common.yes": "yes",
  "common.no": "no",
  "common.on": "on",
  "common.off": "off",

  "peers.self": "You are \"{name}\" (broker: {broker}, auto-wake: {autoWake}, delivery: {delivery}, unread: {unread}).",
  "peers.header": "{count} other peer(s) online:",
  "peers.none": "No other peers are online. Messages you send to an offline peer name wait until it connects.",

  "peers.jobs": "Your running subagents ({count}):",
  "peers.job": "- {name} (model: {model}, running {seconds}s)",

  "jobs.started": "Subagent {name} started. Keep working; its result will arrive as a message from \"{name}\" (or call wait_for_message with from=\"{name}\").",
  "jobs.limit": "Too many subagents running (maximum {max}). Wait for one to finish or cancel one.",
  "jobs.cancelled": "Cancelled subagent {name}.",
  "jobs.unknown": "No running subagent named {name}.",

  "send.ok":"Message {id} sent (conversation {conversation}).",
  "send.delivered": "Delivered to: {names}.",
  "send.queued": "Recipient offline, queued for: {names}.",
  "send.waitHint": "Use wait_for_message to wait for the answer.",

  "inbox.empty": "No unread messages.",
  "wait.timeout": "No message arrived within {seconds} seconds.",

  "autoWake.on": "Auto-wake is on. Incoming peer messages will make this session continue (up to {maxHops} hops per conversation).",
  "autoWake.off": "Auto-wake is off. Peer messages are shown on your next prompt or tool use.",

  "delegate.done": "{agent} finished (session_id: {session}).",
  "delegate.empty": "(no answer text returned)",

  "err.ambiguous": "Several peers match; pick one of: {candidates}.",
  "err.unknownTarget": "Unknown recipient: {detail}",
  "err.tooLarge": "Message too large (maximum {max} characters).",
  "err.protocol": "agent-bridge version mismatch between peers: {detail}. Update all agent-bridge plugins to the same version.",
  "err.generic": "agent-bridge error: {detail}",
  "err.delegateNotFound": "Could not start the other agent: {detail}. Install it or set its path in the agent-bridge config.",
  "err.delegateTimeout": "The delegated agent did not finish in time: {detail}",
  "err.delegateDepth": "Delegation is not available inside a delegated session (prevents endless recursion).",
  "err.delegateFailed": "The delegated agent failed: {detail}",
  "err.delegatedSession": "This is a delegated headless session; peer messaging is disabled here.",

  "cli.usage":
    "Usage: agent-bridge <command>\n\nCommands:\n  status              Show the broker and the connected peers\n  send <to> <text>    Send a message as the \"cli\" peer\n  tail                Print messages addressed to \"cli\" as they arrive\n  paths               Show data, log and pipe locations\n  help                Show this help",
  "cli.status.broker": "Broker: running (pid {pid}, protocol {protocol}) at {pipe}",
  "cli.status.noBroker": "Broker: not running (no agent with agent-bridge is active). Endpoint: {pipe}",
  "cli.status.peers": "Peers online: {count}",
  "cli.status.peer": "  {name}  [{agent}]  since {since}  {cwd}",
  "cli.sent": "Sent message {id}.",
  "cli.tail.listening": "Listening as \"{name}\". Press Ctrl+C to stop.",
  "cli.paths": "Data:  {home}\nLogs:  {logs}\nStore: {db}\nPipe:  {pipe}",
  "cli.error": "Error: {detail}",
  "cli.unknownCommand": "Unknown command: {command}",
} as const;

export type MessageKey = keyof typeof en;

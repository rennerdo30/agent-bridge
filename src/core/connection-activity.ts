/** A server whose accepted connections can be observed (node:http, node:https and node:net servers). */
export interface ObservableServer {
  on(event: "connection", listener: (socket: { once(event: "close", listener: () => void): unknown }) => void): unknown;
}

/**
 * Open connections of the servers a daemon hosts besides its pipe (dashboard HTTP/SSE, mobile HTTPS), plus when
 * the last one closed. Phones poll rather than hold a connection, so recent activity counts as well as open ones.
 */
export class ConnectionActivity {
  private open = 0;
  private last = 0;
  constructor(private readonly now: () => number = Date.now) {}
  track(server: ObservableServer): void {
    server.on("connection", socket => {
      this.open++; this.last = this.now();
      socket.once("close", () => { this.open--; this.last = this.now(); });
    });
  }
  get openConnections(): number { return this.open; }
  /** A connection is open, or one was open less than `recentMs` ago. */
  active(recentMs: number): boolean {
    return this.open > 0 || (this.last > 0 && this.now() - this.last < recentMs);
  }
}

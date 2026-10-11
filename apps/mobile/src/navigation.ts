export type Tab = "overview" | "running" | "questions" | "settings";
export type Route = { kind: "session" | "job" | "question"; id: string } | { kind: "connection" | "notifications" | "about" | "native" | "subagents" };
export interface Navigation { tab: Tab; route: Route | null }
export function back(state: Navigation): Navigation | null { return state.route ? { ...state, route: null } : state.tab !== "overview" ? { tab: "overview", route: null } : null; }

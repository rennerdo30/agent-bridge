import { expect, it } from "vitest";
import { back } from "../src/navigation";
it("returns to originating tab then Overview then platform back", () => { const root = back({ tab: "running", route: { kind: "job", id: "j1" } }); expect(root).toEqual({ tab: "running", route: null }); expect(back(root!)).toEqual({ tab: "overview", route: null }); expect(back({ tab: "overview", route: null })).toBeNull(); });

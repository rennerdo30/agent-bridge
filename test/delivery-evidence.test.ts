import { expect, it, vi } from "vitest";
import { deliveryFailure } from "../src/mcp/delivery-evidence.js";

it.each(["SQLITE_BUSY", "SQLITE_LOCKED", "database is locked"])("bounds diagnostic SQLite message inspection for %s", marker => {
  expect(deliveryFailure({ message: "x".repeat(4096) + marker })).toEqual({ code: "other", reason: "other" });
  expect(deliveryFailure({ message: "x".repeat(4096 - marker.length - 1) + " " + marker })).toEqual({ code: "other", reason: "writer-busy" });
  expect(deliveryFailure({ message: "x".repeat(4091) + " SQLITE_BUSY" })).toEqual({ code: "other", reason: "other" });
});

it("validates diagnostic codes before passing a fresh snapshot to SQLite classification", () => {
  expect(deliveryFailure({ code: "SQLITE_BUSY_" + "x".repeat(4090) })).toEqual({ code: "other", reason: "other" });
  expect(deliveryFailure({ code: "SQLITE_LOCKED_invalid suffix" })).toEqual({ code: "other", reason: "other" });
  expect(deliveryFailure({ code: "SQLITE_BUSY_SNAPSHOT" })).toEqual({ code: "other", reason: "writer-busy" });
  expect(deliveryFailure({ code: "SQLITE_BUSY" })).toEqual({ code: "SQLITE_BUSY", reason: "writer-busy" });
  expect(deliveryFailure({ code: "ELEASEBUSY", message: "not retained in diagnostics" })).toEqual({ code: "ELEASEBUSY", reason: "metadata-owner-unavailable" });
});

it.each([5, 6])("accepts only recognized numeric SQLite busy/locked primary code %s", errcode => {
  expect(deliveryFailure({ errcode })).toEqual({ code: "other", reason: "writer-busy" });
});

it.each([NaN, Infinity, -Infinity, 5.1, -5, 0, 19, 261, 2 ** 32 + 5, "5", true, null, undefined])("does not invent numeric SQLite evidence from malformed or unsupported code %s", errcode => {
  expect(deliveryFailure({ errcode })).toEqual({ code: "other", reason: "other" });
});

it("does not coerce nonstring diagnostic fields or numeric code objects", () => {
  const coercion = vi.fn(() => "SQLITE_BUSY");
  const value = { toString: coercion, valueOf: coercion, [Symbol.toPrimitive]: coercion };
  for (const error of [{ code: value }, { message: value }, { errcode: value }, { code: 5 }, { message: ["SQLITE_BUSY"] }]) {
    expect(deliveryFailure(error)).toEqual({ code: "other", reason: "other" });
  }
  expect(coercion).not.toHaveBeenCalled();
});

it("does not invoke diagnostic field getters or proxy traps", () => {
  const getter = vi.fn(() => { throw new Error("must not inspect accessor"); });
  const error = Object.defineProperties({}, Object.fromEntries(["code", "message", "errcode", "name"].map(key => [key, { get: getter }])));
  expect(deliveryFailure(error)).toEqual({ code: "other", reason: "other" });
  const trap = vi.fn(() => { throw new Error("must not inspect proxy"); });
  const proxy = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  expect(deliveryFailure(proxy)).toEqual({ code: "other", reason: "other" });
  expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
});

it("retains ordinary Error and explicit cancellation names without reading inherited accessors", () => {
  expect(deliveryFailure(new TypeError("private body"))).toEqual({ code: "other", reason: "runtime-type-error" });
  class LocalTypeError extends TypeError {}
  expect(deliveryFailure(new LocalTypeError("private body"))).toEqual({ code: "other", reason: "runtime-type-error" });
  expect(deliveryFailure(Object.assign(new Error("private body"), { name: "AbortError" }))).toEqual({ code: "other", reason: "admission-cancelled" });
  const inherited = vi.fn(() => "SQLITE_BUSY");
  const error = Object.create(Object.defineProperty({}, "message", { get: inherited }));
  expect(deliveryFailure(error)).toEqual({ code: "other", reason: "other" });
  expect(inherited).not.toHaveBeenCalled();
});

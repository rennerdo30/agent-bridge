// Hosted presentation evidence only. Never starts a dashboard, broker or upstream service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";

if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("Hosted Ubuntu capture only");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
assert.equal(head, process.env.PHONES_SOURCE_HEAD, "Capture must check out the exact PR source head");
assert.equal(git("status", "--porcelain=v1", "--untracked-files=no"), "", "Capture source must be clean");
const output = ".agent-bridge-test/phones-dashboard-capture";
mkdirSync(output, { recursive: true });
const sha = value => createHash("sha256").update(value).digest("hex");
const at = 1_800_000_000_000, base = "https://phones.fixture.invalid", viewport = { width: 1440, height: 1100 };
const bundle = await build({ stdin: { contents: 'export { mobileDashboardPage } from "./src/cli/ui-page.ts"; export { default as qrcode } from "./src/mobile/vendor/qrcode.js";', resolveDir: process.cwd(), loader: "js" }, bundle: true, platform: "node", format: "esm", target: "node24", write: false });
const { mobileDashboardPage, qrcode } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
const html = mobileDashboardPage(true);
const projects = [
  { id: "opaque-project-alpha", name: "Alpha", folder: "E:/Fixture/Alpha", sessions: 2, jobs: 3, questions: 1 },
  { id: "opaque-project-beta", name: "Beta", folder: "E:/Fixture/Beta", sessions: 1, jobs: 1, questions: 0 },
];
const sessions = [
  { id: "opaque-session-main", name: "codex-alpha-main", agent: "codex", projectId: projects[0].id },
  { id: "opaque-session-review", name: "claude-alpha-review", agent: "claude", projectId: projects[0].id },
  { id: "opaque-session-beta", name: "codex-beta-main", agent: "codex", projectId: projects[1].id },
];
const claim = { claimId: "synthetic-claim", name: "Fixture iPhone", platform: "ios", comparisonCode: "123456", expiresAt: at + 120_000 };
const phones = { csrfToken: "synthetic-csrf", pending: [], devices: [
  { id: "fixture-ios", name: "Fixture iPhone", platform: "ios", pairedAt: at - 3_600_000, revoked: false, access: { scope: "all", projects: 0, sessions: 0, jobs: 0, answers: false } },
  { id: "fixture-android", name: "Fixture Android", platform: "android", pairedAt: at - 7_200_000, revoked: false, access: { scope: "project", projects: 1, sessions: 0, jobs: 0, answers: true } },
  { id: "fixture-retired", name: "Retired fixture phone", platform: "android", pairedAt: at - 86_400_000, revoked: true, access: { scope: "selected", projects: 0, sessions: 1, jobs: 0, answers: false } },
], catalog: { pcId: "fixture-pc", projects, sessions }, gatewayOrigins: ["https://192.168.1.2:8443", "https://fixture.tailnet.ts.net:8443"], fingerprints: ["AAAA·BBBB·CCCC·DDDD"] };
const network = { enabled: true, identity: { id: "fixture-pc", name: "fixture-pc" }, config: { name: "fixture-pc", bind: "0.0.0.0", port: 48149, discovery: true }, port: 48149, addresses: ["192.168.1.2"], paired: [
  { id: "paired-fixture", name: "fixture-laptop", connected: true, fingerprint: "abcdef0123456789", health: { lastVerifiedAt: at - 60_000, roundTripMs: 8 } },
], discovered: [] };
const state = { brokerPid: 1, version: "0.30.15", peers: sessions.map((session, index) => ({ id: session.id, name: session.name, agent: session.agent, pid: index + 10, cwd: projects[index === 2 ? 1 : 0].folder, sessionId: null, activity: "idle", startedAt: at - 3_600_000, version: "0.30.15" })), runs: [] };
const qrPayload = { v: 2, pcId: "fixture-pc", origin: phones.gatewayOrigins[0], origins: phones.gatewayOrigins, invitationId: "synthetic-invitation", nonce: "synthetic-nonce", pins: ["A".repeat(43)], expiresAt: at + 120_000 };
const qr = qrcode(0, "M"); qr.addData(JSON.stringify(qrPayload)); qr.make();
const invitation = { qr: qrPayload, qrPayload: JSON.stringify(qrPayload), qrSvg: qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }) };
const fixtures = { at, phones, claim, network, state, invitation, settings: { sound: false, toast: false, reminderMinutes: 0 } };
writeFileSync(output + "/fixtures.json", JSON.stringify(fixtures, null, 2) + "\n");
writeFileSync(output + "/rendered.html", html);
const failures = [], requests = [], captures = [];
const browser = await chromium.launch({ headless: true });
const checked = async (page, theme) => {
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
  await page.locator("#status").filter({ hasText: "bridge running" }).waitFor();
  await page.locator("#phDevices [data-ph='revoke-ask']").first().waitFor();
};
function errors(page) {
  page.on("console", message => { if (message.type() === "error") failures.push("console: " + message.text()); });
  page.on("pageerror", error => failures.push("pageerror: " + error.message));
  page.on("requestfailed", request => failures.push("requestfailed: " + request.url()));
}
async function shot(page, name, parameters) {
  assert.deepEqual(failures, [], "Browser and request errors refuse capture");
  const file = "phones-dashboard-" + name + ".png";
  const bytes = await page.screenshot({ path: output + "/" + file, fullPage: true, animations: "disabled" });
  captures.push({ file, sha256: sha(bytes), bytes: bytes.length, ...parameters });
}
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport, colorScheme: theme, locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.addInitScript(theme => localStorage.setItem("ab-theme", theme), theme);
    let pending = false;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      requests.push({ theme, method, path, query: url.search });
      const respond = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      if (url.origin !== base) { failures.push("Unexpected origin: " + url.origin); return route.abort(); }
      if (method === "GET" && path === "/" && !url.search) return route.fulfill({ status: 200, contentType: "text/html", body: html });
      if (method === "GET" && path === "/compare" && !url.search) return route.fulfill({ status: 200, contentType: "text/html", body: '<!doctype html><html><head><title>Synthetic comparison of actual source pages</title></head><body style="margin:0;display:flex"><iframe title="Phones" src="/#/phones" style="border:0;width:1440px;height:1500px"></iframe><iframe title="Network" src="/#/network" style="border:0;width:1440px;height:1500px"></iframe></body></html>' });
      if (method === "GET" && !url.search) {
        if (path === "/api/mobile/phones") return respond({ ...phones, pending: pending ? [claim] : [] });
        if (path === "/api/state") return respond(state);
        if (path === "/api/network") return respond(network);
        if (path === "/api/usage") return respond({ reports: [], at });
        if (path === "/api/models") return respond({ reports: [] });
        if (path === "/api/approvals") return respond({ approvals: [], questions: [] });
        if (path === "/api/resource-slots") return respond({ resources: [] });
        if (path === "/api/job-outcomes") return respond({ jobs: {} });
        if (path === "/api/transfers") return respond({ transfers: [] });
      }
      if (method === "POST" && !url.search) {
        if (path === "/api/dashboard/heartbeat") return respond({ settings: fixtures.settings, alerts: [] });
        if (path === "/api/network/firewall") return respond({ status: { state: "allowed", detail: "Synthetic fixture; no firewall probe" }, plan: { platform: "linux", explanation: "Synthetic" } });
        if (path === "/api/mobile/invitations") {
          assert.equal(request.headers()["x-mobile-admin-csrf"], phones.csrfToken); assert.deepEqual(request.postDataJSON(), {});
          return respond(invitation);
        }
      }
      failures.push("Unexpected request: " + method + " " + request.url()); return route.abort();
    });
    const page = await context.newPage(); errors(page); await page.clock.setFixedTime(at);
    await page.goto(base + "/#/phones"); await checked(page, theme);
    assert.equal(await page.locator("#tabPhones").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("#phDevicesN").textContent(), "2");
    assert.equal(await page.locator("#overview").isVisible(), false);
    await shot(page, "phones-" + theme, { theme, viewport, scenario: "paired list" });
    await page.getByRole("button", { name: "Create pairing QR", exact: true }).click();
    await page.locator("#phPair svg").waitFor();
    await shot(page, "qr-" + theme, { theme, viewport, scenario: "actual vendor QR from synthetic invitation" });
    pending = true; await page.reload(); await checked(page, theme); await page.locator("[data-claim]").waitFor();
    const card = page.locator("[data-claim]");
    assert.equal(await card.locator('[data-ph="mode"][value="all"]').isChecked(), true);
    assert.equal(await card.locator('[data-ph="answers"]').isChecked(), false);
    assert.equal(await card.locator(".ph-match output").textContent(), "123 456");
    await shot(page, "claim-default-" + theme, { theme, viewport, scenario: "whole PC default read-only" });
    await card.locator('[data-ph="mode"][value="project"]').check();
    assert.equal(await card.locator('[data-ph="confirm"]').isDisabled(), true);
    await card.locator('[data-ph="project"][value="opaque-project-alpha"]').check();
    await card.locator('[data-ph="answers"]').check();
    assert.equal(await card.locator('[data-ph="confirm"]').isDisabled(), false);
    await shot(page, "claim-projects-" + theme, { theme, viewport, scenario: "one opaque project and answer opt-in" });
    await card.locator("details.ph-adv summary").click();
    await card.locator('[data-ph="mode"][value="sessions"]').check();
    await card.locator('[data-ph="session"][value="opaque-session-main"]').check();
    assert.equal(await card.locator('[data-ph="answers"]').isDisabled(), true);
    assert.equal(await card.locator('[data-ph="answers"]').isChecked(), false);
    await shot(page, "claim-advanced-" + theme, { theme, viewport, scenario: "exact sessions; answers disabled" });
    // Exercise the same source at a narrow phone viewport; no substitute mobile layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "claim-advanced-mobile-" + theme, { theme, viewport: { width: 390, height: 844 }, scenario: "exact sessions, narrow viewport" });
    await page.setViewportSize(viewport);
    await page.locator("#tabNet").click(); await page.locator("#netState").filter({ hasText: "Networking is on" }).waitFor();
    assert.equal(await page.locator("#phones").isVisible(), false);
    await shot(page, "network-" + theme, { theme, viewport, scenario: "unchanged Network" });
    const comparison = await context.newPage(); errors(comparison); await comparison.clock.setFixedTime(at);
    await comparison.setViewportSize({ width: 2880, height: 1500 }); await comparison.goto(base + "/compare");
    const left = comparison.frameLocator('iframe[title="Phones"]'), right = comparison.frameLocator('iframe[title="Network"]');
    await left.locator("[data-claim]").waitFor(); await right.locator("#netState").filter({ hasText: "Networking is on" }).waitFor();
    await shot(comparison, "side-by-side-" + theme, { theme, viewport: { width: 2880, height: 1500 }, scenario: "two unmodified source pages in comparison-only iframe wrapper" });
    await context.close();
  }
  assert.deepEqual(failures, []);
  assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
  const versions = Object.fromEntries(["playwright", "playwright-core", "esbuild"].map(name => [name, JSON.parse(readFileSync("node_modules/" + name + "/package.json", "utf8")).version]));
  assert.equal(versions.playwright, "1.64.1"); assert.equal(versions["playwright-core"], "1.64.1");
  const sourceFiles = ["src/cli/ui-page.ts", "src/cli/markdown.ts", "src/cli/logo.ts", "src/network/constants.ts", "src/mobile/vendor/qrcode.js", "scripts/capture-phones-dashboard.mjs", ".github/workflows/phones-dashboard-capture.yml", "package.json", "package-lock.json"];
  const manifest = { result: "passed", sourceHead: process.env.PHONES_SOURCE_HEAD, checkoutCommit: head, checkoutTree: tree, renderedHtmlSha256: sha(html), rendererBundleSha256: sha(bundle.outputFiles[0].contents), fixtureFileSha256: sha(readFileSync(output + "/fixtures.json")), source: sourceFiles.map(path => ({ path, blob: git("rev-parse", "HEAD:" + path), sha256: sha(readFileSync(path)) })),
    versions: { ...versions, chromium: browser.version(), node: process.version }, parameters: { fixedTime: at, timezone: "UTC", locale: "en-US", deviceScaleFactor: 1, reducedMotion: "reduce", animations: "disabled", headless: true },
    hosted: { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, runnerOs: process.env.RUNNER_OS }, captures, requests, failures,
    limits: "Synthetic intercepted presentation only; no broker/app server, backend authorization, real devices, secure storage, native TLS, owner runtime or provider acceptance." };
  writeFileSync(output + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log("Captured " + captures.length + " actual-source synthetic PNGs at " + head);
} finally { await browser.close(); }

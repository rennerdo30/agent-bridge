import { FAVICON_HREF, LOGO_SVG } from "./logo.js";

export const UI_RECOVERY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-bridge — Open dashboard</title><link rel="icon" href="${FAVICON_HREF}">
<style>
:root{color-scheme:light dark;font-family:"Segoe UI",system-ui,sans-serif;color:#161b26;background:#f4f5f7}
body{margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:520px;margin:24px;padding:32px;border:1px solid #e4e7ec;border-radius:16px;background:#fff}
header{display:flex;align-items:center;gap:12px;color:#4f46e5;font-weight:600}header svg{width:32px;height:32px}h1{font-size:24px}p{line-height:1.6}code{background:#eef0ff;color:#4f46e5;padding:3px 6px;border-radius:4px}
@media(prefers-color-scheme:dark){:root{color:#e8eaf0;background:#141720}main{background:#1c202b;border-color:#34394a}code{background:#292c46;color:#b5b0ff}}
</style></head><body><main><header>${LOGO_SVG} agent-bridge</header><h1>Open your dashboard again</h1>
<p>This browser needs dashboard access. Run <code>/agent-bridge:dashboard</code> in your agent session or <code>agent-bridge ui</code> in a terminal.</p>
<p>Either command opens the current dashboard and automatically restores the browser cookie. You can then refresh this page.</p>
</main></body></html>`;

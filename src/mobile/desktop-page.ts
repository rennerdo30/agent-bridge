/**
 * The former standalone Phones URL (/mobile/phones). Phones is now a section of the dashboard, so this
 * static page only forwards there; it is served behind the same desktop cookie, Host and readiness gates.
 */
export const MOBILE_DESKTOP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=/#/phones"><title>agent-bridge · Phones</title></head><body><p><a href="/#/phones">Open Phones in the dashboard</a></p></body></html>`;

// Test-only fixture, not shipped (test/ is not in package.json "files"). Stubs global fetch so a
// CLI subprocess test can read a chosen llms.txt without a network call: the body comes from the
// LLMS_TXT_BODY environment variable, every other URL answers with an empty HTML page.
// Loaded with `node --import` ahead of bin/cli.mjs.
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/llms.txt")) {
    return new Response(process.env.LLMS_TXT_BODY, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
};

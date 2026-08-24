// turva-llms-txt-validator: validate a site's llms.txt structure.
// The checks mirror the hosted validator at https://turva.dev/llms-txt-validator,
// which runs this same logic inside the turva.dev Cloudflare Worker
// (https://github.com/erekola/turva-worker). The hosted validator stays
// canonical: if the two ever disagree, the hosted one wins and this package
// gets the fix.

import { readFileSync } from "node:fs";

// Version comes from package.json so the two can never drift again
// (0.1.1 and 0.1.3 both shipped with a stale hardcoded VERSION).
export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
const UA = "turva-llms-txt-validator/" + VERSION + " (+https://turva.dev/llms-txt-validator)";

export function normalizeHostInput(raw) {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.port && u.port !== "443" && u.port !== "80") return null;
  if (u.username || u.password) return null;
  return u.hostname;
}

export function isValidPublicHost(host) {
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return false;
  const tld = host.split(".").pop();
  if (["localhost", "local", "internal", "home", "lan", "corp", "test", "invalid"].includes(tld)) return false;
  return true;
}

// opts.path and opts.accept were added for the v2 discovery checks, which need the
// site's home page as well as its llms.txt. Nothing else moved: the redirect budget,
// the same-host rule, the credential and port rejections and the 256 KB cap are the
// guards this function was measured against.
export async function fetchLlmsTxt(host, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const cap = opts.cap ?? 262144;
  const reqApex = host.startsWith("www.") ? host.slice(4) : host;
  let url = "https://" + host + (opts.path ?? "/llms.txt");
  let redirectedFrom = null;
  // One budget for the whole redirect chain, not one per hop. Mirrors the hosted validator
  // (turva.dev/llms-txt-validator), which is canonical: with five hops a per-hop signal made
  // the caller's timeout five times longer than the value it passed in.
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      headers: { "user-agent": opts.userAgent ?? UA, "accept": opts.accept ?? "text/plain, text/markdown;q=0.9, */*;q=0.1" }
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      if (!loc) return { redirect: true, reason: "no-location", status: res.status, location: "" };
      if (hop >= 4) return { redirect: true, reason: "too-many", status: res.status, location: loc.slice(0, 120) };
      let next;
      try { next = new URL(loc, url); } catch { return { redirect: true, reason: "bad-location", status: res.status, location: loc.slice(0, 120) }; }
      const safeTarget = next.protocol === "https:" && !next.port && !next.username && !next.password && isValidPublicHost(next.hostname);
      const twin = (next.hostname.startsWith("www.") ? next.hostname.slice(4) : next.hostname) === reqApex;
      if (!safeTarget) return { redirect: true, reason: "unsafe-target", status: res.status, location: next.href.slice(0, 120) };
      if (!twin) return { redirect: true, reason: "off-host", status: res.status, location: next.href.slice(0, 120) };
      if (!redirectedFrom) redirectedFrom = url;
      url = next.href;
      continue;
    }
    let bytes = 0, truncated = false;
    const chunks = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > cap) {
          truncated = true;
          chunks.push(value.slice(0, value.length - (bytes - cap)));
          bytes = cap;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(bytes);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    return {
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      linkHeader: res.headers.get("link") || "",
      text: new TextDecoder("utf-8").decode(buf),
      bytes,
      truncated,
      redirectedFrom,
      finalUrl: url
    };
  }
}

function redirectFailDetail(f) {
  if (f.reason === "off-host") return "redirects to " + f.location + ", a different host; llms.txt is host-scoped, so validate that host directly";
  if (f.reason === "unsafe-target") return "redirects to an unsupported target (" + f.location + "); only https redirects to the same site are followed";
  if (f.reason === "too-many") return "too many redirects; the llms.txt is not served at a stable URL";
  return "got a " + f.status + " redirect without a usable Location header";
}

export function validateLlmsTxt(f) {
  const checks = [];
  const add = (id, status, label, detail) => checks.push({ id, status, label, detail });
  if (f.redirect) {
    add("http-status", "fail", "File exists at /llms.txt", redirectFailDetail(f));
    return checks;
  }
  if (f.status !== 200) {
    add("http-status", "fail", "File exists at /llms.txt", "expected HTTP 200, got " + f.status);
    return checks;
  }
  add("http-status", "pass", "File exists at /llms.txt", f.redirectedFrom ? "HTTP 200, followed a redirect from " + f.redirectedFrom + " to " + f.finalUrl : "HTTP 200");
  const ct = (f.contentType || "").toLowerCase();
  const looksHtml = /^\s*(<!doctype|<html|<head|<body)/i.test(f.text);
  if (looksHtml) {
    add("content-type", "fail", "Response is plain text", "the body looks like an HTML page, not an llms.txt file");
    return checks;
  }
  if (ct.includes("text/plain") || ct.includes("text/markdown")) {
    add("content-type", "pass", "Response is plain text", ct.split(";")[0]);
  } else {
    add("content-type", "warn", "Response is plain text", "content-type is " + (ct.split(";")[0] || "missing") + ", text/plain or text/markdown is the convention");
  }
  const lines = f.text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  const first = firstIdx === -1 ? "" : lines[firstIdx].trim();
  if (/^# \S/.test(first)) {
    add("h1-title", "pass", "Starts with an H1 title", JSON.stringify(first.slice(0, 80)));
  } else {
    add("h1-title", "fail", "Starts with an H1 title", "the first non-empty line should be a markdown H1 (# Site name)");
  }
  const afterH1 = lines.slice(firstIdx + 1).find((l) => l.trim() !== "") || "";
  if (afterH1.trim().startsWith("> ")) {
    add("summary", "pass", "Blockquote summary after the title", JSON.stringify(afterH1.trim().slice(0, 80)));
  } else {
    add("summary", "warn", "Blockquote summary after the title", "recommended by the format (> one-line summary), not required");
  }
  const h2Count = (f.text.match(/^## /gm) || []).length;
  if (h2Count > 0) {
    add("sections", "pass", "H2 sections group the content", h2Count + " section" + (h2Count === 1 ? "" : "s"));
  } else {
    add("sections", "warn", "H2 sections group the content", "no H2 sections found; sections are the convention for grouping links");
  }
  const links = [...f.text.matchAll(/\[([^\][]*)\]\(([^)\s]{1,2048})\)/g)];
  const absolute = links.filter((m) => /^https?:\/\//.test(m[2])).length;
  if (links.length === 0) {
    add("links", "warn", "Markdown links an agent can follow", "no markdown links found");
  } else if (absolute === links.length) {
    add("links", "pass", "Markdown links an agent can follow", links.length + " link" + (links.length === 1 ? "" : "s") + ", all absolute URLs");
  } else {
    add("links", "warn", "Markdown links an agent can follow", links.length + " links, " + (links.length - absolute) + " relative; absolute URLs travel better when the file is read out of context");
  }
  if (f.truncated) {
    add("size", "warn", "Small enough to be cheap to read", "over 256 KB, read truncated");
  } else if (f.bytes <= 51200) {
    add("size", "pass", "Small enough to be cheap to read", f.bytes + " bytes");
  } else {
    add("size", "warn", "Small enough to be cheap to read", f.bytes + " bytes; consider moving detail to llms-full.txt");
  }
  if (/<[a-z][a-z0-9-]*[\s>]/i.test(f.text)) {
    add("no-html", "warn", "No HTML markup in the file", "HTML tags found; llms.txt should be plain markdown");
  } else {
    add("no-html", "pass", "No HTML markup in the file", "plain markdown");
  }
  return checks;
}

// v2 of the llms.txt proposal (August 2026) left the file format alone and added one
// thing: a page should say where its markdown version and its llms.txt are, using
// rel="alternate" type="text/markdown" and rel="describedby", as HTML link elements or
// as a Link response header. That is a property of the site, not of the file, so these
// two carry their own status, "info". They are never a warn and never a fail, the
// summary line is unchanged, and --strict keeps exiting on warnings only.
export function findLinkRelations(html, linkHeader) {
  const found = { describedby: null, markdown: null };
  // Comments are stripped first: a commented-out link element is not published,
  // and counting one would report a relation the site does not serve. With no
  // </head> the first 64 KB are scanned, body included, so a malformed document
  // does not silently report nothing found.
  const text = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const cut = text.toLowerCase().indexOf("</head>");
  const head = cut === -1 ? text.slice(0, 65536) : text.slice(0, cut);
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const rel = ((tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || "").toLowerCase().trim().split(/\s+/);
    const type = ((tag.match(/\btype\s*=\s*["']?([^"'>\s]+)/i) || [])[1] || "").toLowerCase();
    const href = ((tag.match(/\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'|\bhref\s*=\s*([^\s"'>]+)/i) || []).slice(1).find((x) => x !== undefined) || "").trim();
    if (!found.describedby && rel.includes("describedby")) found.describedby = href || "(link element without href)";
    if (!found.markdown && rel.includes("alternate") && type.startsWith("text/markdown")) found.markdown = href || "(link element without href)";
  }
  for (const part of String(linkHeader || "").split(/,(?=\s*<)/)) {
    const href = ((part.match(/<([^>]*)>/) || [])[1] || "").trim();
    const rel = ((part.match(/rel\s*=\s*"?([^";,]+)"?/i) || [])[1] || "").toLowerCase().trim().split(/\s+/);
    const type = ((part.match(/type\s*=\s*"?([^";,]+)"?/i) || [])[1] || "").toLowerCase().trim();
    if (!found.describedby && rel.includes("describedby")) found.describedby = href || "(Link header without a target)";
    if (!found.markdown && rel.includes("alternate") && type.startsWith("text/markdown")) found.markdown = href || "(Link header without a target)";
  }
  return found;
}

export function validateV2Discovery(found, unreadReason) {
  const checks = [];
  const add = (id, status, label, detail) => checks.push({ id, status, label, detail });
  if (!found) {
    add("v2-describedby", "info", "Home page points to its llms.txt (v2)", unreadReason);
    add("v2-markdown-alternate", "info", "Home page points to a markdown version (v2)", unreadReason);
    return checks;
  }
  add("v2-describedby", found.describedby ? "pass" : "info", "Home page points to its llms.txt (v2)",
    found.describedby ? 'rel="describedby" to ' + found.describedby.slice(0, 120) : 'no rel="describedby" in the head or the Link header; v2 recommends it so an agent finds the file without guessing');
  add("v2-markdown-alternate", found.markdown ? "pass" : "info", "Home page points to a markdown version (v2)",
    found.markdown ? 'rel="alternate" type="text/markdown" to ' + found.markdown.slice(0, 120) : 'no rel="alternate" type="text/markdown" in the head or the Link header; v2 recommends it so an agent finds the markdown form without guessing');
  return checks;
}

export function summarizeChecks(checks) {
  if (checks.some((c) => c.status === "fail")) return "not valid";
  if (checks.some((c) => c.status === "warn")) return "valid with warnings";
  return "valid";
}

export async function validateHost(input, opts = {}) {
  const host = normalizeHostInput(input);
  if (!host || !isValidPublicHost(host)) {
    throw new Error("not a public domain name: " + String(input).slice(0, 120));
  }
  // opts comes from the caller, and path and accept exist for this function's own
  // second read. Forwarding them to the first read would let a caller point the
  // "llms.txt" result at any path on the host, so both are pinned here.
  const fetched = await fetchLlmsTxt(host, { ...opts, path: "/llms.txt", accept: undefined });
  let discovery;
  try {
    const home = await fetchLlmsTxt(host, { ...opts, path: "/", accept: "text/html, */*;q=0.1" });
    discovery = home.redirect
      ? validateV2Discovery(null, "the home page redirects away from this host, so this was not measured")
      : home.status !== 200
        ? validateV2Discovery(null, "the home page returned HTTP " + home.status + ", so this was not measured")
        : validateV2Discovery(findLinkRelations(home.text, home.linkHeader));
  } catch {
    discovery = validateV2Discovery(null, "the home page could not be read, so this was not measured");
  }
  const checks = validateLlmsTxt(fetched).concat(discovery);
  return { target: "https://" + host + "/llms.txt", summary: summarizeChecks(checks), checks };
}

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

// A "<" starts a tag only when a letter, "!", "/" or "?" follows it. Anything else is
// text, and the NEXT "<" can still start a tag. Measured, not assumed: without this rule
// "<<style><link rel=describedby ...>" read the link as published while a real parser
// treats the first "<" as text, opens style, and publishes nothing.
function startsTag(c) {
  return c !== undefined && (c === "!" || c === "/" || c === "?" || (c >= "a" && c <= "z"));
}

// The end of the tag that starts at lt: the first ">" that is NOT inside a quoted
// attribute value. A quote opens a value only right after "=", which is what the
// tokenizer does. indexOf(">") is wrong here: <link data-x="a>b" rel="describedby"> is
// one tag for a parser and two for indexOf, and the relation was lost.
function tagEnd(text, lt) {
  let quote = "", afterEq = false;
  for (let j = lt + 1; j < text.length; j++) {
    const c = text[j];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === ">") return j;
    if (c === "=") { afterEq = true; continue; }
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") continue;
    if (afterEq && (c === '"' || c === "'")) { quote = c; afterEq = false; continue; }
    afterEq = false;
  }
  return -1;
}

// The comment and raw text strip is one left to right scan by index, not a regex, and
// that is a measured decision rather than a style. A character class that reads a tag's
// attributes, /<(script|style)\b[^>]*>/, is quadratic on input the TARGET site controls:
// every "<script" with no ">" after it scans to the end of the document, and 256 KB of
// them took seconds. Bounding the class to a fixed length fixes the speed and buys a
// worse bug: an open tag longer than the bound stops being recognised, its element is
// not stripped, and a <link rel="describedby"> written inside a script string is then
// read as a published relation, which is the one thing this measurement may not do. A
// scan has no bound and no backtracking, and it visits every character once.
//
// What it removes, all of it measured against a real HTML parser (parse5) rather than
// reasoned about. An unterminated <!-- comments out the rest of the document, so the
// scan stops there. <!--> and <!---> are EMPTY comments, not unterminated ones, and
// --!> ends a comment as well. script, style, title and textarea are raw text or
// RCDATA, where a tag is text rather than markup, and template content is inert, so a
// link element inside any of them is not published while one after the closing tag is;
// an unclosed one swallows the rest of the document. Order is not a choice in a single
// scan, which is what earlier versions got wrong in both directions: a comment that
// mentions <script> in prose is only a comment, and <script><!-- ... </script> hides
// nothing that follows it.
var RAW_TEXT_ELEMENTS = ["script", "style", "template", "title", "textarea"];

// The end of a raw text element: the first </name that is followed by optional
// whitespace and a ">". Returns the index after it, or -1 when the element never closes.
function rawTextEnd(lower, name, from) {
  const needle = "</" + name;
  for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    let j = at + needle.length;
    const space = () => { while (j < lower.length && (lower[j] === " " || lower[j] === "\t" || lower[j] === "\n" || lower[j] === "\r" || lower[j] === "\f")) j++; };
    space();
    if (lower[j] === "/") { j++; space(); }   // </script/> closes the element too
    if (lower[j] === ">") return j + 1;
  }
  return -1;
}

function stripCommentsAndRawText(html) {
  const text = String(html || "");
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  for (;;) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      if (lower.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (lower.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const dashes = lower.indexOf("-->", lt + 4);
      const bang = lower.indexOf("--!>", lt + 4);
      if (dashes === -1 && bang === -1) break;
      i = (bang === -1 || (dashes !== -1 && dashes <= bang)) ? dashes + 3 : bang + 4;
      continue;
    }
    if (!startsTag(lower[lt + 1])) { out.push("<"); i = lt + 1; continue; }
    const gt = tagEnd(text, lt);
    if (gt === -1) break;
    const name = (/^<([a-z]+)(?=[\s/>]|$)/.exec(lower.slice(lt, Math.min(lt + 12, gt + 1))) || [])[1];
    if (!name || !RAW_TEXT_ELEMENTS.includes(name)) { out.push(text.slice(lt, gt + 1)); i = gt + 1; continue; }
    const end = rawTextEnd(lower, name, gt + 1);
    if (end === -1) break;
    i = end;
  }
  return out.join("");
}

// Tags are found by index and not by /<link\b[^>]*>/g, on purpose. That regex is
// quadratic on input the TARGET site controls: every "<link" with no ">" after it makes
// the character class scan to the end of the document, and "<link" repeated 16 000 times
// measured 196 ms where this loop measures under 1 ms. CodeQL reports the same shape as
// js/polynomial-redos (alerts #4 and #5 on the package repo, 2026-08-24). This scan
// visits every character once: from each "<" it reads to the next ">" and then continues
// after it, which is what the regex meant to say.
function* htmlTags(text) {
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const open = lower.indexOf("<", i);
    if (open === -1) return;
    if (!startsTag(lower[open + 1])) { i = open + 1; continue; }
    const close = tagEnd(text, open);
    if (close === -1) return;
    yield text.slice(open, close + 1);
    i = close + 1;
  }
}

// v2 of the llms.txt proposal (August 2026) left the file format alone and added one
// thing: a page should say where its markdown version and its llms.txt are, using
// rel="alternate" type="text/markdown" and rel="describedby", as HTML link elements or
// as a Link response header. That is a property of the site, not of the file, so these
// two carry their own status, "info". They are never a warn and never a fail, the
// summary line is unchanged, and --strict keeps exiting on warnings only.
export function findLinkRelations(html, linkHeader) {
  const found = { describedby: null, markdown: null };
  // Comments and raw text are stripped first: a commented-out link element is not
  // published, and counting one would report a relation the site does not serve. See
  // stripCommentsAndRawText above for what that means shape by shape. With no </head>
  // the first 64 KB are scanned, body included, so a malformed document does not
  // silently report nothing found. Three known differences from a real parser are left
  // standing on purpose: noscript, nested templates, and the head a parser closes at its
  // first text node. Measured over 48 document shapes against parse5, 2026-08-24.
  const text = stripCommentsAndRawText(html);
  const cut = text.toLowerCase().indexOf("</head>");
  const head = cut === -1 ? text.slice(0, 65536) : text.slice(0, cut);
  for (const tag of htmlTags(head)) {
    // The name has to END at "link": a real parser reads "<link<link" as ONE tag whose
    // NAME is "link<link", not as a link element, so \b would count a relation the site
    // does not publish. Measured against parse5, 2026-08-24.
    if (!/^<link(?=[\s/>])/i.test(tag)) continue;
    const rel = ((tag.match(/\brel\s*=\s*["']?([^"'>]+)/i) || [])[1] || "").toLowerCase().trim().split(/\s+/);
    const type = ((tag.match(/\btype\s*=\s*["']?([^"'>\s]+)/i) || [])[1] || "").toLowerCase();
    const href = ((tag.match(/\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'|\bhref\s*=\s*([^\s"'>]+)/i) || []).slice(1).find((x) => x !== undefined) || "").trim();
    if (!found.describedby && rel.includes("describedby")) found.describedby = href || "(link element without href)";
    if (!found.markdown && rel.includes("alternate") && type.startsWith("text/markdown")) found.markdown = href || "(link element without href)";
  }
  for (const part of String(linkHeader || "").split(/,(?=\s*<)/)) {
    const lt = part.indexOf("<");
    const gt = lt === -1 ? -1 : part.indexOf(">", lt + 1);
    const href = (gt === -1 ? "" : part.slice(lt + 1, gt)).trim();
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

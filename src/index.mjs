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
// The hosted validator identifies itself without a version, because its version is the
// site's and moves with every release; this package carries its own. The two strings
// differ on purpose and nothing compares them (round 16 S3-6).
const UA = "turva-llms-txt-validator/" + VERSION + " (+https://turva.dev/llms-txt-validator)";

// Cut a string to at most n UTF-16 code units without leaving a lone high surrogate at the
// end. String.prototype.slice counts code units, so a cut that lands inside a surrogate
// pair leaves half of it, and the character is lost. How the half is written depends on
// the runtime: Node's UTF-8 encoder replaces it with U+FFFD, and the hosted validator in
// workerd wrote three bytes that were not valid UTF-8 (round 16 S3-1 and S3-2, measured
// there 2026-09-03). Mirrors worker.js cut().
export function cut(s, n) {
  s = String(s).slice(0, n);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

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
      // Six paths leave this branch, five returns and one continue, and not one of them
      // ever reads the redirect body. undici holds the connection until a body is read or
      // cancelled, so it is released here, once, before the location is even parsed. A
      // failed cancel must not turn a redirect verdict into a throw (2026-09-10).
      try { await res.body?.cancel(); } catch { /* the verdict below is the answer */ }
      const loc = res.headers.get("location") || "";
      if (!loc) return { redirect: true, reason: "no-location", status: res.status, location: "" };
      if (hop >= 4) return { redirect: true, reason: "too-many", status: res.status, location: cut(loc, 120) };
      let next;
      try { next = new URL(loc, url); } catch { return { redirect: true, reason: "bad-location", status: res.status, location: cut(loc, 120) }; }
      const safeTarget = next.protocol === "https:" && !next.port && !next.username && !next.password && isValidPublicHost(next.hostname);
      const twin = (next.hostname.startsWith("www.") ? next.hostname.slice(4) : next.hostname) === reqApex;
      if (!safeTarget) return { redirect: true, reason: "unsafe-target", status: res.status, location: cut(next.href, 120) };
      if (!twin) return { redirect: true, reason: "off-host", status: res.status, location: cut(next.href, 120) };
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

// Every markdown link in the file, scanned once from left to right instead of collected with
// matchAll(/\[([^\][]*)\]\(([^)\s]{1,2048})\)/g). That bound meant a target longer than 2048
// characters was not counted as a link at all, and dropping the bound from the pattern would
// make it quadratic on a file that repeats "[a](" (Erik 2026-08-29). The scan carries no bound
// and no backtracking: every character is read once and the furthest failed target scan is
// remembered. matchAll resumes after a whole match, and so does this.
function collectLinks(text) {
  const out = [];
  let failEnd = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let j = i + 1;
    while (j < text.length && text[j] !== "]" && text[j] !== "[") j++;
    if (j >= text.length) break;
    if (text[j] === "[") { i = j - 1; continue; }
    if (text[j + 1] !== "(") { i = j; continue; }
    const k = j + 2;
    if (k <= failEnd) { i = j + 1; continue; }
    let e = k;
    while (e < text.length && text[e] !== ")" && !/\s/.test(text[e])) e++;
    if (e > k && text[e] === ")") { out.push({ name: text.slice(i + 1, j), target: text.slice(k, e) }); i = e; continue; }
    if (text[e] !== ")") failEnd = e;
    i = j + 1;
  }
  return out;
}

// CommonMark fenced code blocks, marked line by line. A "## " or a link inside a fence is
// example text and not the file's own structure, but until 2026-09-10 both counted, so a
// file whose only section and only link lived inside ``` or ~~~ was reported valid. The
// scan is one pass over the lines with no backtracking pattern, because the ReDoS repair
// of 2026-08-24 bought a worse accuracy defect with a bounded quantifier and the rule out
// of it was to scan by index instead (mds/gotchas.md 2026-08-24 (jatko 12)).
// Returns one boolean per line: true for a fence line and for everything inside it.
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let fenceChar = "", fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let p = 0;
    while (p < 4 && l[p] === " ") p++;
    if (p > 3) { mask[i] = fenceChar !== ""; continue; }
    const c = l[p];
    let run = 0;
    if (c === "`" || c === "~") { while (l[p + run] === c) run++; }
    if (fenceChar === "") {
      // An opening backtick fence may not carry a backtick in its info string; a tilde
      // fence may. Anything shorter than three markers is not a fence at all. A later
      // round will read the consequence as a bug and it is not: in ```js `x` the info
      // string holds a backtick, so that line is prose, and a bare ``` after it OPENS a
      // block instead of closing one. CommonMark reads the same input the same way,
      // measured against the spec 2026-09-10. Leave it.
      if (run >= 3 && (c !== "`" || l.indexOf("`", p + run) === -1)) {
        fenceChar = c; fenceLen = run; mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (c === fenceChar && run >= fenceLen && l.slice(p + run).trim() === "") { fenceChar = ""; fenceLen = 0; }
  }
  return mask;
}
// A markdown list item that carries a link, scanned once from left to right instead of
// matched with /^ {0,3}[-*+] .*\[[^\][]*\]\([^)\s]+\)/. That pattern is quadratic on a line
// such as "- " followed by "[a](" repeated, because every candidate rescans the target to the
// end of the line, and the line comes from the audited site (CodeQL js/polynomial-redos,
// 2026-08-29). Bounding the quantifier would trade the speed bug for a silent accuracy bug,
// so the scan is by index: every character is read once and the furthest failed target scan
// is remembered.
function listItemHasLink(l) {
  const m = /^ {0,3}[-*+] /.exec(l);
  if (!m) return false;
  const isSep = (c) => c === "\r" || c === "\n" || c === "\u2028" || c === "\u2029";
  let failEnd = -1;
  for (let i = m[0].length; i < l.length; i++) {
    // A "." in the old pattern never crosses a line terminator, and split(/\r?\n/) leaves
    // a bare CR, U+2028 and U+2029 inside a line, so a link behind one was not a match then
    // and is not one now.
    if (isSep(l[i])) return false;
    if (l[i] !== "[") continue;
    let j = i + 1, sep = false;
    while (j < l.length && l[j] !== "]" && l[j] !== "[") { if (isSep(l[j])) sep = true; j++; }
    if (j >= l.length) return false;
    if (l[j] === "[") { if (sep) return false; i = j - 1; continue; }
    if (l[j + 1] !== "(") { if (sep) return false; i = j; continue; }
    const k = j + 2;
    if (k <= failEnd) { if (sep) return false; i = j + 1; continue; }
    let e = k;
    while (e < l.length && l[e] !== ")" && !/\s/.test(l[e])) e++;
    if (e > k && l[e] === ")") return true;
    if (sep) return false;
    if (l[e] !== ")") failEnd = e;
    i = j + 1;
  }
  return false;
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
  const firstRaw = firstIdx === -1 ? "" : lines[firstIdx];
  const first = firstRaw.trim();
  // The line is read as markdown and not trimmed first. Four spaces or a tab make it an
  // indented code block rather than a heading, and trimming erased that difference, so
  // "    # Site" passed as the H1 until 2026-08-29. CommonMark allows three spaces.
  if (/^ {0,3}# \S/.test(firstRaw)) {
    add("h1-title", "pass", "Starts with an H1 title", JSON.stringify(cut(first, 80)));
  } else {
    add("h1-title", "fail", "Starts with an H1 title", "the first non-empty line should be a markdown H1 (# Site name)");
  }
  const afterH1 = lines.slice(firstIdx + 1).find((l) => l.trim() !== "") || "";
  if (afterH1.trim().startsWith("> ")) {
    add("summary", "pass", "Blockquote summary after the title", JSON.stringify(cut(afterH1.trim(), 80)));
  } else {
    add("summary", "warn", "Blockquote summary after the title", "recommended by the format (> one-line summary), not required");
  }
  // Headings are read outside fences only, and with the same indentation the H1 check and
  // listItemHasLink have allowed since 2026-08-29. Until 2026-09-10 this one line still
  // demanded column zero, so a correct file indented by one to three spaces was reported as
  // having no sections at all while its list under the same indentation counted fine.
  const fenced = fenceMask(lines);
  const h2Count = lines.filter((l, i) => !fenced[i] && /^ {0,3}## /.test(l)).length;
  // A section counts when it carries a file list. An H2 followed by a paragraph satisfied
  // this check until 2026-08-29, and the format puts each section's links in a list.
  let sectionsWithList = 0;
  {
    let inSection = false, counted = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (fenced[i]) continue;
      if (/^ {0,3}## /.test(l)) { inSection = true; counted = false; continue; }
      if (/^ {0,3}# /.test(l)) { inSection = false; continue; }
      if (inSection && !counted && listItemHasLink(l)) { sectionsWithList++; counted = true; }
    }
  }
  if (h2Count > 0 && sectionsWithList > 0) {
    add("sections", "pass", "H2 sections group the content", h2Count + " section" + (h2Count === 1 ? "" : "s") + ", " + sectionsWithList + " carrying a file list");
  } else if (h2Count > 0) {
    add("sections", "warn", "H2 sections group the content", h2Count + " section" + (h2Count === 1 ? "" : "s") + " but no file list under any of them; the format puts a section's links in a markdown list");
  } else {
    add("sections", "warn", "H2 sections group the content", "no H2 sections found; sections are the convention for grouping links");
  }
  // Links are collected from the prose only, for the same reason the headings are: a link
  // shown inside a code fence is an example of a link, not one an agent can follow.
  const links = collectLinks(lines.filter((l, i) => !fenced[i]).join("\n"));
  // An entry an agent can use has a name and a target with a host. An empty name and a
  // bare "https://" both counted as valid absolute links until 2026-08-29.
  const named = links.filter((m) => m.name.trim() !== "");
  const unnamed = links.length - named.length;
  const absolute = named.filter((m) => /^https?:\/\/[^/\s?#]+/.test(m.target)).length;
  if (links.length === 0) {
    add("links", "warn", "Markdown links an agent can follow", "no markdown links found");
  } else if (unnamed > 0) {
    add("links", "warn", "Markdown links an agent can follow", links.length + " link" + (links.length === 1 ? "" : "s") + ", " + unnamed + " with an empty link name; an entry needs a name an agent can show");
  } else if (absolute === named.length) {
    add("links", "pass", "Markdown links an agent can follow", named.length + " link" + (named.length === 1 ? "" : "s") + ", all absolute URLs");
  } else {
    const relativeCount = named.filter((m) => !/^[a-z][a-z0-9+.-]*:/i.test(m.target)).length;
    const hostless = named.length - absolute - relativeCount;
    add("links", "warn", "Markdown links an agent can follow", named.length + " links, " + relativeCount + " relative" + (hostless > 0 ? " and " + hostless + " with a scheme but no host" : "") + "; absolute URLs travel better when the file is read out of context");
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

// One tag read with the tokenizer's own states, from the "<" at lt: the tag name, then before
// attribute name, attribute name, after attribute name, before attribute value, the three value
// states, after a quoted value and self-closing start tag. Returns the index of the ">" that
// ends the tag, or -1 when the input ends first, in which case a parser drops the tag. When attrs
// is an object it also receives the attributes: names ASCII lowercased, values with their
// character references decoded, and the first declaration of a name wins.
// indexOf(">") is wrong here: <link data-x="a>b" rel="describedby"> is one tag for a parser and
// two for indexOf, and the relation was lost. The shortcut that replaced it opened a quote after
// any "=", which the tokenizer does not do either: in a="x"=">" the second "=" starts an attribute
// NAME, and so does an "=" where a name is expected, so the quote after it is part of that name
// and the ">" inside it ends the tag. Measured against parse5, 2026-09-12.
function readTag(text, lt, attrs) {
  const n = text.length;
  let j = lt + 1;
  if (text[j] === "/") j++;
  while (j < n && !isTagBoundary(text[j])) j++;
  let state = "before", name = "", start = 0, quote = "";
  const add = (value) => {
    if (attrs && !(name in attrs)) attrs[name] = decodeAttributeValue(value);
  };
  for (; j < n; j++) {
    const c = text[j];
    if (state === "before") {
      if (HTML_WHITESPACE.includes(c)) continue;
      if (c === "/") { state = "selfClosing"; continue; }
      if (c === ">") return j;
      // Any other character starts a name, "=" included.
      start = j;
      state = "name";
    } else if (state === "name") {
      if (HTML_WHITESPACE.includes(c)) { name = asciiLower(text.slice(start, j)); state = "afterName"; continue; }
      if (c === "/" || c === ">") {
        name = asciiLower(text.slice(start, j));
        add("");
        if (c === ">") return j;
        state = "selfClosing";
        continue;
      }
      if (c === "=" && j > start) { name = asciiLower(text.slice(start, j)); state = "beforeValue"; }
    } else if (state === "afterName") {
      if (HTML_WHITESPACE.includes(c)) continue;
      if (c === "=") { state = "beforeValue"; continue; }
      add("");
      if (c === "/") { state = "selfClosing"; continue; }
      if (c === ">") return j;
      start = j;
      state = "name";
    } else if (state === "beforeValue") {
      if (HTML_WHITESPACE.includes(c)) continue;
      if (c === '"' || c === "'") { quote = c; start = j + 1; state = "quoted"; continue; }
      if (c === ">") { add(""); return j; }
      start = j;
      state = "unquoted";
    } else if (state === "quoted") {
      if (c === quote) { add(text.slice(start, j)); state = "afterQuoted"; }
    } else if (state === "unquoted") {
      if (HTML_WHITESPACE.includes(c)) { add(text.slice(start, j)); state = "before"; continue; }
      if (c === ">") { add(text.slice(start, j)); return j; }
    } else if (state === "afterQuoted") {
      if (HTML_WHITESPACE.includes(c)) { state = "before"; continue; }
      if (c === "/") { state = "selfClosing"; continue; }
      if (c === ">") return j;
      // A missing space between attributes: the character starts the next name.
      start = j;
      state = "name";
    } else {
      // selfClosing: only ">" ends the tag, anything else is read again as before attribute name.
      if (c === ">") return j;
      state = "before";
      j--;
    }
  }
  return -1;
}

function tagEnd(text, lt) {
  return readTag(text, lt, null);
}

// ASCII only, on purpose. The HTML tokenizer lowercases A to Z and nothing else, and HTML
// whitespace is tab, LF, FF, CR and space. toLowerCase, trim and \s are Unicode aware, and each
// of them read a page differently from a parser: U+0130 lowercases to two UTF-16 code units, so
// every index taken from the lowered copy pointed past its place in the original and a relation
// after it was lost; U+212A lowercases to "k"; and NBSP counted as whitespace between head
// elements, where a parser starts the body, and between rel tokens. Measured against parse5,
// 2026-09-12.
function asciiLower(s) {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

var HTML_WHITESPACE = " \t\n\r\f";
// A MIME type is trimmed of HTTP whitespace, which does not include FF.
var HTTP_WHITESPACE = " \t\n\r";

function trimChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function isHtmlWhitespace(s) {
  for (let k = 0; k < s.length; k++) if (!HTML_WHITESPACE.includes(s[k])) return false;
  return true;
}

function isAsciiAlphanumeric(c) {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"));
}

// Character references in an attribute value, decoded after the tag has been tokenized and
// never before it: decoding the source first would let a decoded quote move where a value
// ends. The rules are those of the tokenizer's character reference state inside an attribute
// value. The longest named reference wins. A name without its ";" decodes only for the legacy
// names that allow it, and not when "=" or an ASCII letter or digit follows, so "?a=1&ampb=2"
// stays as written. A numeric reference takes decimal or hex digits with the ";" optional;
// zero, a surrogate and anything past U+10FFFF become U+FFFD, and 0x80 to 0x9F go through
// the replacement table below. A NUL in the value becomes U+FFFD as well. Before this,
// rel="described&#98;y" read as no relation and href="/llms.txt?a=1&amp;b=2" was reported
// with "&amp;" still in it.
var C1_REPLACEMENTS = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

// The full WHATWG list of named character references, 2 231 names: "name!hex" is a name that
// also decodes without its ";", "name=hex" one that needs it, and several code points are
// separated by ",". Generated 2026-09-12 from the character-entities package, with every value
// and every legacy name checked against the decoder of the entities package.
var NAMED_REFERENCE_DATA =
  "AElig!c6 AMP!26 Aacute!c1 Abreve=102 Acirc!c2 Acy=410 Afr=1d504 Agrave!c0 Alpha=391 Amacr=100 " +
  "And=2a53 Aogon=104 Aopf=1d538 ApplyFunction=2061 Aring!c5 Ascr=1d49c Assign=2254 Atilde!c3 " +
  "Auml!c4 Backslash=2216 Barv=2ae7 Barwed=2306 Bcy=411 Because=2235 Bernoullis=212c Beta=392 " +
  "Bfr=1d505 Bopf=1d539 Breve=2d8 Bscr=212c Bumpeq=224e CHcy=427 COPY!a9 Cacute=106 Cap=22d2 " +
  "CapitalDifferentialD=2145 Cayleys=212d Ccaron=10c Ccedil!c7 Ccirc=108 Cconint=2230 Cdot=10a " +
  "Cedilla=b8 CenterDot=b7 Cfr=212d Chi=3a7 CircleDot=2299 CircleMinus=2296 CirclePlus=2295 " +
  "CircleTimes=2297 ClockwiseContourIntegral=2232 CloseCurlyDoubleQuote=201d CloseCurlyQuote=2019 " +
  "Colon=2237 Colone=2a74 Congruent=2261 Conint=222f ContourIntegral=222e Copf=2102 Coproduct=2210 " +
  "CounterClockwiseContourIntegral=2233 Cross=2a2f Cscr=1d49e Cup=22d3 CupCap=224d DD=2145 " +
  "DDotrahd=2911 DJcy=402 DScy=405 DZcy=40f Dagger=2021 Darr=21a1 Dashv=2ae4 Dcaron=10e Dcy=414 " +
  "Del=2207 Delta=394 Dfr=1d507 DiacriticalAcute=b4 DiacriticalDot=2d9 DiacriticalDoubleAcute=2dd " +
  "DiacriticalGrave=60 DiacriticalTilde=2dc Diamond=22c4 DifferentialD=2146 Dopf=1d53b Dot=a8 " +
  "DotDot=20dc DotEqual=2250 DoubleContourIntegral=222f DoubleDot=a8 DoubleDownArrow=21d3 " +
  "DoubleLeftArrow=21d0 DoubleLeftRightArrow=21d4 DoubleLeftTee=2ae4 DoubleLongLeftArrow=27f8 " +
  "DoubleLongLeftRightArrow=27fa DoubleLongRightArrow=27f9 DoubleRightArrow=21d2 " +
  "DoubleRightTee=22a8 DoubleUpArrow=21d1 DoubleUpDownArrow=21d5 DoubleVerticalBar=2225 " +
  "DownArrow=2193 DownArrowBar=2913 DownArrowUpArrow=21f5 DownBreve=311 DownLeftRightVector=2950 " +
  "DownLeftTeeVector=295e DownLeftVector=21bd DownLeftVectorBar=2956 DownRightTeeVector=295f " +
  "DownRightVector=21c1 DownRightVectorBar=2957 DownTee=22a4 DownTeeArrow=21a7 Downarrow=21d3 " +
  "Dscr=1d49f Dstrok=110 ENG=14a ETH!d0 Eacute!c9 Ecaron=11a Ecirc!ca Ecy=42d Edot=116 Efr=1d508 " +
  "Egrave!c8 Element=2208 Emacr=112 EmptySmallSquare=25fb EmptyVerySmallSquare=25ab Eogon=118 " +
  "Eopf=1d53c Epsilon=395 Equal=2a75 EqualTilde=2242 Equilibrium=21cc Escr=2130 Esim=2a73 Eta=397 " +
  "Euml!cb Exists=2203 ExponentialE=2147 Fcy=424 Ffr=1d509 FilledSmallSquare=25fc " +
  "FilledVerySmallSquare=25aa Fopf=1d53d ForAll=2200 Fouriertrf=2131 Fscr=2131 GJcy=403 GT!3e " +
  "Gamma=393 Gammad=3dc Gbreve=11e Gcedil=122 Gcirc=11c Gcy=413 Gdot=120 Gfr=1d50a Gg=22d9 " +
  "Gopf=1d53e GreaterEqual=2265 GreaterEqualLess=22db GreaterFullEqual=2267 GreaterGreater=2aa2 " +
  "GreaterLess=2277 GreaterSlantEqual=2a7e GreaterTilde=2273 Gscr=1d4a2 Gt=226b HARDcy=42a " +
  "Hacek=2c7 Hat=5e Hcirc=124 Hfr=210c HilbertSpace=210b Hopf=210d HorizontalLine=2500 Hscr=210b " +
  "Hstrok=126 HumpDownHump=224e HumpEqual=224f IEcy=415 IJlig=132 IOcy=401 Iacute!cd Icirc!ce " +
  "Icy=418 Idot=130 Ifr=2111 Igrave!cc Im=2111 Imacr=12a ImaginaryI=2148 Implies=21d2 Int=222c " +
  "Integral=222b Intersection=22c2 InvisibleComma=2063 InvisibleTimes=2062 Iogon=12e Iopf=1d540 " +
  "Iota=399 Iscr=2110 Itilde=128 Iukcy=406 Iuml!cf Jcirc=134 Jcy=419 Jfr=1d50d Jopf=1d541 " +
  "Jscr=1d4a5 Jsercy=408 Jukcy=404 KHcy=425 KJcy=40c Kappa=39a Kcedil=136 Kcy=41a Kfr=1d50e " +
  "Kopf=1d542 Kscr=1d4a6 LJcy=409 LT!3c Lacute=139 Lambda=39b Lang=27ea Laplacetrf=2112 Larr=219e " +
  "Lcaron=13d Lcedil=13b Lcy=41b LeftAngleBracket=27e8 LeftArrow=2190 LeftArrowBar=21e4 " +
  "LeftArrowRightArrow=21c6 LeftCeiling=2308 LeftDoubleBracket=27e6 LeftDownTeeVector=2961 " +
  "LeftDownVector=21c3 LeftDownVectorBar=2959 LeftFloor=230a LeftRightArrow=2194 " +
  "LeftRightVector=294e LeftTee=22a3 LeftTeeArrow=21a4 LeftTeeVector=295a LeftTriangle=22b2 " +
  "LeftTriangleBar=29cf LeftTriangleEqual=22b4 LeftUpDownVector=2951 LeftUpTeeVector=2960 " +
  "LeftUpVector=21bf LeftUpVectorBar=2958 LeftVector=21bc LeftVectorBar=2952 Leftarrow=21d0 " +
  "Leftrightarrow=21d4 LessEqualGreater=22da LessFullEqual=2266 LessGreater=2276 LessLess=2aa1 " +
  "LessSlantEqual=2a7d LessTilde=2272 Lfr=1d50f Ll=22d8 Lleftarrow=21da Lmidot=13f " +
  "LongLeftArrow=27f5 LongLeftRightArrow=27f7 LongRightArrow=27f6 Longleftarrow=27f8 " +
  "Longleftrightarrow=27fa Longrightarrow=27f9 Lopf=1d543 LowerLeftArrow=2199 LowerRightArrow=2198 " +
  "Lscr=2112 Lsh=21b0 Lstrok=141 Lt=226a Map=2905 Mcy=41c MediumSpace=205f Mellintrf=2133 Mfr=1d510 " +
  "MinusPlus=2213 Mopf=1d544 Mscr=2133 Mu=39c NJcy=40a Nacute=143 Ncaron=147 Ncedil=145 Ncy=41d " +
  "NegativeMediumSpace=200b NegativeThickSpace=200b NegativeThinSpace=200b " +
  "NegativeVeryThinSpace=200b NestedGreaterGreater=226b NestedLessLess=226a NewLine=a Nfr=1d511 " +
  "NoBreak=2060 NonBreakingSpace=a0 Nopf=2115 Not=2aec NotCongruent=2262 NotCupCap=226d " +
  "NotDoubleVerticalBar=2226 NotElement=2209 NotEqual=2260 NotEqualTilde=2242,338 NotExists=2204 " +
  "NotGreater=226f NotGreaterEqual=2271 NotGreaterFullEqual=2267,338 NotGreaterGreater=226b,338 " +
  "NotGreaterLess=2279 NotGreaterSlantEqual=2a7e,338 NotGreaterTilde=2275 NotHumpDownHump=224e,338 " +
  "NotHumpEqual=224f,338 NotLeftTriangle=22ea NotLeftTriangleBar=29cf,338 NotLeftTriangleEqual=22ec " +
  "NotLess=226e NotLessEqual=2270 NotLessGreater=2278 NotLessLess=226a,338 " +
  "NotLessSlantEqual=2a7d,338 NotLessTilde=2274 NotNestedGreaterGreater=2aa2,338 " +
  "NotNestedLessLess=2aa1,338 NotPrecedes=2280 NotPrecedesEqual=2aaf,338 NotPrecedesSlantEqual=22e0 " +
  "NotReverseElement=220c NotRightTriangle=22eb NotRightTriangleBar=29d0,338 " +
  "NotRightTriangleEqual=22ed NotSquareSubset=228f,338 NotSquareSubsetEqual=22e2 " +
  "NotSquareSuperset=2290,338 NotSquareSupersetEqual=22e3 NotSubset=2282,20d2 NotSubsetEqual=2288 " +
  "NotSucceeds=2281 NotSucceedsEqual=2ab0,338 NotSucceedsSlantEqual=22e1 NotSucceedsTilde=227f,338 " +
  "NotSuperset=2283,20d2 NotSupersetEqual=2289 NotTilde=2241 NotTildeEqual=2244 " +
  "NotTildeFullEqual=2247 NotTildeTilde=2249 NotVerticalBar=2224 Nscr=1d4a9 Ntilde!d1 Nu=39d " +
  "OElig=152 Oacute!d3 Ocirc!d4 Ocy=41e Odblac=150 Ofr=1d512 Ograve!d2 Omacr=14c Omega=3a9 " +
  "Omicron=39f Oopf=1d546 OpenCurlyDoubleQuote=201c OpenCurlyQuote=2018 Or=2a54 Oscr=1d4aa " +
  "Oslash!d8 Otilde!d5 Otimes=2a37 Ouml!d6 OverBar=203e OverBrace=23de OverBracket=23b4 " +
  "OverParenthesis=23dc PartialD=2202 Pcy=41f Pfr=1d513 Phi=3a6 Pi=3a0 PlusMinus=b1 " +
  "Poincareplane=210c Popf=2119 Pr=2abb Precedes=227a PrecedesEqual=2aaf PrecedesSlantEqual=227c " +
  "PrecedesTilde=227e Prime=2033 Product=220f Proportion=2237 Proportional=221d Pscr=1d4ab Psi=3a8 " +
  "QUOT!22 Qfr=1d514 Qopf=211a Qscr=1d4ac RBarr=2910 REG!ae Racute=154 Rang=27eb Rarr=21a0 " +
  "Rarrtl=2916 Rcaron=158 Rcedil=156 Rcy=420 Re=211c ReverseElement=220b ReverseEquilibrium=21cb " +
  "ReverseUpEquilibrium=296f Rfr=211c Rho=3a1 RightAngleBracket=27e9 RightArrow=2192 " +
  "RightArrowBar=21e5 RightArrowLeftArrow=21c4 RightCeiling=2309 RightDoubleBracket=27e7 " +
  "RightDownTeeVector=295d RightDownVector=21c2 RightDownVectorBar=2955 RightFloor=230b " +
  "RightTee=22a2 RightTeeArrow=21a6 RightTeeVector=295b RightTriangle=22b3 RightTriangleBar=29d0 " +
  "RightTriangleEqual=22b5 RightUpDownVector=294f RightUpTeeVector=295c RightUpVector=21be " +
  "RightUpVectorBar=2954 RightVector=21c0 RightVectorBar=2953 Rightarrow=21d2 Ropf=211d " +
  "RoundImplies=2970 Rrightarrow=21db Rscr=211b Rsh=21b1 RuleDelayed=29f4 SHCHcy=429 SHcy=428 " +
  "SOFTcy=42c Sacute=15a Sc=2abc Scaron=160 Scedil=15e Scirc=15c Scy=421 Sfr=1d516 " +
  "ShortDownArrow=2193 ShortLeftArrow=2190 ShortRightArrow=2192 ShortUpArrow=2191 Sigma=3a3 " +
  "SmallCircle=2218 Sopf=1d54a Sqrt=221a Square=25a1 SquareIntersection=2293 SquareSubset=228f " +
  "SquareSubsetEqual=2291 SquareSuperset=2290 SquareSupersetEqual=2292 SquareUnion=2294 Sscr=1d4ae " +
  "Star=22c6 Sub=22d0 Subset=22d0 SubsetEqual=2286 Succeeds=227b SucceedsEqual=2ab0 " +
  "SucceedsSlantEqual=227d SucceedsTilde=227f SuchThat=220b Sum=2211 Sup=22d1 Superset=2283 " +
  "SupersetEqual=2287 Supset=22d1 THORN!de TRADE=2122 TSHcy=40b TScy=426 Tab=9 Tau=3a4 Tcaron=164 " +
  "Tcedil=162 Tcy=422 Tfr=1d517 Therefore=2234 Theta=398 ThickSpace=205f,200a ThinSpace=2009 " +
  "Tilde=223c TildeEqual=2243 TildeFullEqual=2245 TildeTilde=2248 Topf=1d54b TripleDot=20db " +
  "Tscr=1d4af Tstrok=166 Uacute!da Uarr=219f Uarrocir=2949 Ubrcy=40e Ubreve=16c Ucirc!db Ucy=423 " +
  "Udblac=170 Ufr=1d518 Ugrave!d9 Umacr=16a UnderBar=5f UnderBrace=23df UnderBracket=23b5 " +
  "UnderParenthesis=23dd Union=22c3 UnionPlus=228e Uogon=172 Uopf=1d54c UpArrow=2191 " +
  "UpArrowBar=2912 UpArrowDownArrow=21c5 UpDownArrow=2195 UpEquilibrium=296e UpTee=22a5 " +
  "UpTeeArrow=21a5 Uparrow=21d1 Updownarrow=21d5 UpperLeftArrow=2196 UpperRightArrow=2197 Upsi=3d2 " +
  "Upsilon=3a5 Uring=16e Uscr=1d4b0 Utilde=168 Uuml!dc VDash=22ab Vbar=2aeb Vcy=412 Vdash=22a9 " +
  "Vdashl=2ae6 Vee=22c1 Verbar=2016 Vert=2016 VerticalBar=2223 VerticalLine=7c " +
  "VerticalSeparator=2758 VerticalTilde=2240 VeryThinSpace=200a Vfr=1d519 Vopf=1d54d Vscr=1d4b1 " +
  "Vvdash=22aa Wcirc=174 Wedge=22c0 Wfr=1d51a Wopf=1d54e Wscr=1d4b2 Xfr=1d51b Xi=39e Xopf=1d54f " +
  "Xscr=1d4b3 YAcy=42f YIcy=407 YUcy=42e Yacute!dd Ycirc=176 Ycy=42b Yfr=1d51c Yopf=1d550 " +
  "Yscr=1d4b4 Yuml=178 ZHcy=416 Zacute=179 Zcaron=17d Zcy=417 Zdot=17b ZeroWidthSpace=200b Zeta=396 " +
  "Zfr=2128 Zopf=2124 Zscr=1d4b5 aacute!e1 abreve=103 ac=223e acE=223e,333 acd=223f acirc!e2 " +
  "acute!b4 acy=430 aelig!e6 af=2061 afr=1d51e agrave!e0 alefsym=2135 aleph=2135 alpha=3b1 " +
  "amacr=101 amalg=2a3f amp!26 and=2227 andand=2a55 andd=2a5c andslope=2a58 andv=2a5a ang=2220 " +
  "ange=29a4 angle=2220 angmsd=2221 angmsdaa=29a8 angmsdab=29a9 angmsdac=29aa angmsdad=29ab " +
  "angmsdae=29ac angmsdaf=29ad angmsdag=29ae angmsdah=29af angrt=221f angrtvb=22be angrtvbd=299d " +
  "angsph=2222 angst=c5 angzarr=237c aogon=105 aopf=1d552 ap=2248 apE=2a70 apacir=2a6f ape=224a " +
  "apid=224b apos=27 approx=2248 approxeq=224a aring!e5 ascr=1d4b6 ast=2a asymp=2248 asympeq=224d " +
  "atilde!e3 auml!e4 awconint=2233 awint=2a11 bNot=2aed backcong=224c backepsilon=3f6 " +
  "backprime=2035 backsim=223d backsimeq=22cd barvee=22bd barwed=2305 barwedge=2305 bbrk=23b5 " +
  "bbrktbrk=23b6 bcong=224c bcy=431 bdquo=201e becaus=2235 because=2235 bemptyv=29b0 bepsi=3f6 " +
  "bernou=212c beta=3b2 beth=2136 between=226c bfr=1d51f bigcap=22c2 bigcirc=25ef bigcup=22c3 " +
  "bigodot=2a00 bigoplus=2a01 bigotimes=2a02 bigsqcup=2a06 bigstar=2605 bigtriangledown=25bd " +
  "bigtriangleup=25b3 biguplus=2a04 bigvee=22c1 bigwedge=22c0 bkarow=290d blacklozenge=29eb " +
  "blacksquare=25aa blacktriangle=25b4 blacktriangledown=25be blacktriangleleft=25c2 " +
  "blacktriangleright=25b8 blank=2423 blk12=2592 blk14=2591 blk34=2593 block=2588 bne=3d,20e5 " +
  "bnequiv=2261,20e5 bnot=2310 bopf=1d553 bot=22a5 bottom=22a5 bowtie=22c8 boxDL=2557 boxDR=2554 " +
  "boxDl=2556 boxDr=2553 boxH=2550 boxHD=2566 boxHU=2569 boxHd=2564 boxHu=2567 boxUL=255d " +
  "boxUR=255a boxUl=255c boxUr=2559 boxV=2551 boxVH=256c boxVL=2563 boxVR=2560 boxVh=256b " +
  "boxVl=2562 boxVr=255f boxbox=29c9 boxdL=2555 boxdR=2552 boxdl=2510 boxdr=250c boxh=2500 " +
  "boxhD=2565 boxhU=2568 boxhd=252c boxhu=2534 boxminus=229f boxplus=229e boxtimes=22a0 boxuL=255b " +
  "boxuR=2558 boxul=2518 boxur=2514 boxv=2502 boxvH=256a boxvL=2561 boxvR=255e boxvh=253c " +
  "boxvl=2524 boxvr=251c bprime=2035 breve=2d8 brvbar!a6 bscr=1d4b7 bsemi=204f bsim=223d bsime=22cd " +
  "bsol=5c bsolb=29c5 bsolhsub=27c8 bull=2022 bullet=2022 bump=224e bumpE=2aae bumpe=224f " +
  "bumpeq=224f cacute=107 cap=2229 capand=2a44 capbrcup=2a49 capcap=2a4b capcup=2a47 capdot=2a40 " +
  "caps=2229,fe00 caret=2041 caron=2c7 ccaps=2a4d ccaron=10d ccedil!e7 ccirc=109 ccups=2a4c " +
  "ccupssm=2a50 cdot=10b cedil!b8 cemptyv=29b2 cent!a2 centerdot=b7 cfr=1d520 chcy=447 check=2713 " +
  "checkmark=2713 chi=3c7 cir=25cb cirE=29c3 circ=2c6 circeq=2257 circlearrowleft=21ba " +
  "circlearrowright=21bb circledR=ae circledS=24c8 circledast=229b circledcirc=229a " +
  "circleddash=229d cire=2257 cirfnint=2a10 cirmid=2aef cirscir=29c2 clubs=2663 clubsuit=2663 " +
  "colon=3a colone=2254 coloneq=2254 comma=2c commat=40 comp=2201 compfn=2218 complement=2201 " +
  "complexes=2102 cong=2245 congdot=2a6d conint=222e copf=1d554 coprod=2210 copy!a9 copysr=2117 " +
  "crarr=21b5 cross=2717 cscr=1d4b8 csub=2acf csube=2ad1 csup=2ad0 csupe=2ad2 ctdot=22ef " +
  "cudarrl=2938 cudarrr=2935 cuepr=22de cuesc=22df cularr=21b6 cularrp=293d cup=222a cupbrcap=2a48 " +
  "cupcap=2a46 cupcup=2a4a cupdot=228d cupor=2a45 cups=222a,fe00 curarr=21b7 curarrm=293c " +
  "curlyeqprec=22de curlyeqsucc=22df curlyvee=22ce curlywedge=22cf curren!a4 curvearrowleft=21b6 " +
  "curvearrowright=21b7 cuvee=22ce cuwed=22cf cwconint=2232 cwint=2231 cylcty=232d dArr=21d3 " +
  "dHar=2965 dagger=2020 daleth=2138 darr=2193 dash=2010 dashv=22a3 dbkarow=290f dblac=2dd " +
  "dcaron=10f dcy=434 dd=2146 ddagger=2021 ddarr=21ca ddotseq=2a77 deg!b0 delta=3b4 demptyv=29b1 " +
  "dfisht=297f dfr=1d521 dharl=21c3 dharr=21c2 diam=22c4 diamond=22c4 diamondsuit=2666 diams=2666 " +
  "die=a8 digamma=3dd disin=22f2 div=f7 divide!f7 divideontimes=22c7 divonx=22c7 djcy=452 " +
  "dlcorn=231e dlcrop=230d dollar=24 dopf=1d555 dot=2d9 doteq=2250 doteqdot=2251 dotminus=2238 " +
  "dotplus=2214 dotsquare=22a1 doublebarwedge=2306 downarrow=2193 downdownarrows=21ca " +
  "downharpoonleft=21c3 downharpoonright=21c2 drbkarow=2910 drcorn=231f drcrop=230c dscr=1d4b9 " +
  "dscy=455 dsol=29f6 dstrok=111 dtdot=22f1 dtri=25bf dtrif=25be duarr=21f5 duhar=296f dwangle=29a6 " +
  "dzcy=45f dzigrarr=27ff eDDot=2a77 eDot=2251 eacute!e9 easter=2a6e ecaron=11b ecir=2256 ecirc!ea " +
  "ecolon=2255 ecy=44d edot=117 ee=2147 efDot=2252 efr=1d522 eg=2a9a egrave!e8 egs=2a96 egsdot=2a98 " +
  "el=2a99 elinters=23e7 ell=2113 els=2a95 elsdot=2a97 emacr=113 empty=2205 emptyset=2205 " +
  "emptyv=2205 emsp13=2004 emsp14=2005 emsp=2003 eng=14b ensp=2002 eogon=119 eopf=1d556 epar=22d5 " +
  "eparsl=29e3 eplus=2a71 epsi=3b5 epsilon=3b5 epsiv=3f5 eqcirc=2256 eqcolon=2255 eqsim=2242 " +
  "eqslantgtr=2a96 eqslantless=2a95 equals=3d equest=225f equiv=2261 equivDD=2a78 eqvparsl=29e5 " +
  "erDot=2253 erarr=2971 escr=212f esdot=2250 esim=2242 eta=3b7 eth!f0 euml!eb euro=20ac excl=21 " +
  "exist=2203 expectation=2130 exponentiale=2147 fallingdotseq=2252 fcy=444 female=2640 ffilig=fb03 " +
  "fflig=fb00 ffllig=fb04 ffr=1d523 filig=fb01 fjlig=66,6a flat=266d fllig=fb02 fltns=25b1 fnof=192 " +
  "fopf=1d557 forall=2200 fork=22d4 forkv=2ad9 fpartint=2a0d frac12!bd frac13=2153 frac14!bc " +
  "frac15=2155 frac16=2159 frac18=215b frac23=2154 frac25=2156 frac34!be frac35=2157 frac38=215c " +
  "frac45=2158 frac56=215a frac58=215d frac78=215e frasl=2044 frown=2322 fscr=1d4bb gE=2267 " +
  "gEl=2a8c gacute=1f5 gamma=3b3 gammad=3dd gap=2a86 gbreve=11f gcirc=11d gcy=433 gdot=121 ge=2265 " +
  "gel=22db geq=2265 geqq=2267 geqslant=2a7e ges=2a7e gescc=2aa9 gesdot=2a80 gesdoto=2a82 " +
  "gesdotol=2a84 gesl=22db,fe00 gesles=2a94 gfr=1d524 gg=226b ggg=22d9 gimel=2137 gjcy=453 gl=2277 " +
  "glE=2a92 gla=2aa5 glj=2aa4 gnE=2269 gnap=2a8a gnapprox=2a8a gne=2a88 gneq=2a88 gneqq=2269 " +
  "gnsim=22e7 gopf=1d558 grave=60 gscr=210a gsim=2273 gsime=2a8e gsiml=2a90 gt!3e gtcc=2aa7 " +
  "gtcir=2a7a gtdot=22d7 gtlPar=2995 gtquest=2a7c gtrapprox=2a86 gtrarr=2978 gtrdot=22d7 " +
  "gtreqless=22db gtreqqless=2a8c gtrless=2277 gtrsim=2273 gvertneqq=2269,fe00 gvnE=2269,fe00 " +
  "hArr=21d4 hairsp=200a half=bd hamilt=210b hardcy=44a harr=2194 harrcir=2948 harrw=21ad hbar=210f " +
  "hcirc=125 hearts=2665 heartsuit=2665 hellip=2026 hercon=22b9 hfr=1d525 hksearow=2925 " +
  "hkswarow=2926 hoarr=21ff homtht=223b hookleftarrow=21a9 hookrightarrow=21aa hopf=1d559 " +
  "horbar=2015 hscr=1d4bd hslash=210f hstrok=127 hybull=2043 hyphen=2010 iacute!ed ic=2063 icirc!ee " +
  "icy=438 iecy=435 iexcl!a1 iff=21d4 ifr=1d526 igrave!ec ii=2148 iiiint=2a0c iiint=222d " +
  "iinfin=29dc iiota=2129 ijlig=133 imacr=12b image=2111 imagline=2110 imagpart=2111 imath=131 " +
  "imof=22b7 imped=1b5 in=2208 incare=2105 infin=221e infintie=29dd inodot=131 int=222b intcal=22ba " +
  "integers=2124 intercal=22ba intlarhk=2a17 intprod=2a3c iocy=451 iogon=12f iopf=1d55a iota=3b9 " +
  "iprod=2a3c iquest!bf iscr=1d4be isin=2208 isinE=22f9 isindot=22f5 isins=22f4 isinsv=22f3 " +
  "isinv=2208 it=2062 itilde=129 iukcy=456 iuml!ef jcirc=135 jcy=439 jfr=1d527 jmath=237 jopf=1d55b " +
  "jscr=1d4bf jsercy=458 jukcy=454 kappa=3ba kappav=3f0 kcedil=137 kcy=43a kfr=1d528 kgreen=138 " +
  "khcy=445 kjcy=45c kopf=1d55c kscr=1d4c0 lAarr=21da lArr=21d0 lAtail=291b lBarr=290e lE=2266 " +
  "lEg=2a8b lHar=2962 lacute=13a laemptyv=29b4 lagran=2112 lambda=3bb lang=27e8 langd=2991 " +
  "langle=27e8 lap=2a85 laquo!ab larr=2190 larrb=21e4 larrbfs=291f larrfs=291d larrhk=21a9 " +
  "larrlp=21ab larrpl=2939 larrsim=2973 larrtl=21a2 lat=2aab latail=2919 late=2aad lates=2aad,fe00 " +
  "lbarr=290c lbbrk=2772 lbrace=7b lbrack=5b lbrke=298b lbrksld=298f lbrkslu=298d lcaron=13e " +
  "lcedil=13c lceil=2308 lcub=7b lcy=43b ldca=2936 ldquo=201c ldquor=201e ldrdhar=2967 " +
  "ldrushar=294b ldsh=21b2 le=2264 leftarrow=2190 leftarrowtail=21a2 leftharpoondown=21bd " +
  "leftharpoonup=21bc leftleftarrows=21c7 leftrightarrow=2194 leftrightarrows=21c6 " +
  "leftrightharpoons=21cb leftrightsquigarrow=21ad leftthreetimes=22cb leg=22da leq=2264 leqq=2266 " +
  "leqslant=2a7d les=2a7d lescc=2aa8 lesdot=2a7f lesdoto=2a81 lesdotor=2a83 lesg=22da,fe00 " +
  "lesges=2a93 lessapprox=2a85 lessdot=22d6 lesseqgtr=22da lesseqqgtr=2a8b lessgtr=2276 " +
  "lesssim=2272 lfisht=297c lfloor=230a lfr=1d529 lg=2276 lgE=2a91 lhard=21bd lharu=21bc " +
  "lharul=296a lhblk=2584 ljcy=459 ll=226a llarr=21c7 llcorner=231e llhard=296b lltri=25fa " +
  "lmidot=140 lmoust=23b0 lmoustache=23b0 lnE=2268 lnap=2a89 lnapprox=2a89 lne=2a87 lneq=2a87 " +
  "lneqq=2268 lnsim=22e6 loang=27ec loarr=21fd lobrk=27e6 longleftarrow=27f5 " +
  "longleftrightarrow=27f7 longmapsto=27fc longrightarrow=27f6 looparrowleft=21ab " +
  "looparrowright=21ac lopar=2985 lopf=1d55d loplus=2a2d lotimes=2a34 lowast=2217 lowbar=5f " +
  "loz=25ca lozenge=25ca lozf=29eb lpar=28 lparlt=2993 lrarr=21c6 lrcorner=231f lrhar=21cb " +
  "lrhard=296d lrm=200e lrtri=22bf lsaquo=2039 lscr=1d4c1 lsh=21b0 lsim=2272 lsime=2a8d lsimg=2a8f " +
  "lsqb=5b lsquo=2018 lsquor=201a lstrok=142 lt!3c ltcc=2aa6 ltcir=2a79 ltdot=22d6 lthree=22cb " +
  "ltimes=22c9 ltlarr=2976 ltquest=2a7b ltrPar=2996 ltri=25c3 ltrie=22b4 ltrif=25c2 lurdshar=294a " +
  "luruhar=2966 lvertneqq=2268,fe00 lvnE=2268,fe00 mDDot=223a macr!af male=2642 malt=2720 " +
  "maltese=2720 map=21a6 mapsto=21a6 mapstodown=21a7 mapstoleft=21a4 mapstoup=21a5 marker=25ae " +
  "mcomma=2a29 mcy=43c mdash=2014 measuredangle=2221 mfr=1d52a mho=2127 micro!b5 mid=2223 midast=2a " +
  "midcir=2af0 middot!b7 minus=2212 minusb=229f minusd=2238 minusdu=2a2a mlcp=2adb mldr=2026 " +
  "mnplus=2213 models=22a7 mopf=1d55e mp=2213 mscr=1d4c2 mstpos=223e mu=3bc multimap=22b8 " +
  "mumap=22b8 nGg=22d9,338 nGt=226b,20d2 nGtv=226b,338 nLeftarrow=21cd nLeftrightarrow=21ce " +
  "nLl=22d8,338 nLt=226a,20d2 nLtv=226a,338 nRightarrow=21cf nVDash=22af nVdash=22ae nabla=2207 " +
  "nacute=144 nang=2220,20d2 nap=2249 napE=2a70,338 napid=224b,338 napos=149 napprox=2249 " +
  "natur=266e natural=266e naturals=2115 nbsp!a0 nbump=224e,338 nbumpe=224f,338 ncap=2a43 " +
  "ncaron=148 ncedil=146 ncong=2247 ncongdot=2a6d,338 ncup=2a42 ncy=43d ndash=2013 ne=2260 " +
  "neArr=21d7 nearhk=2924 nearr=2197 nearrow=2197 nedot=2250,338 nequiv=2262 nesear=2928 " +
  "nesim=2242,338 nexist=2204 nexists=2204 nfr=1d52b ngE=2267,338 nge=2271 ngeq=2271 ngeqq=2267,338 " +
  "ngeqslant=2a7e,338 nges=2a7e,338 ngsim=2275 ngt=226f ngtr=226f nhArr=21ce nharr=21ae nhpar=2af2 " +
  "ni=220b nis=22fc nisd=22fa niv=220b njcy=45a nlArr=21cd nlE=2266,338 nlarr=219a nldr=2025 " +
  "nle=2270 nleftarrow=219a nleftrightarrow=21ae nleq=2270 nleqq=2266,338 nleqslant=2a7d,338 " +
  "nles=2a7d,338 nless=226e nlsim=2274 nlt=226e nltri=22ea nltrie=22ec nmid=2224 nopf=1d55f not!ac " +
  "notin=2209 notinE=22f9,338 notindot=22f5,338 notinva=2209 notinvb=22f7 notinvc=22f6 notni=220c " +
  "notniva=220c notnivb=22fe notnivc=22fd npar=2226 nparallel=2226 nparsl=2afd,20e5 npart=2202,338 " +
  "npolint=2a14 npr=2280 nprcue=22e0 npre=2aaf,338 nprec=2280 npreceq=2aaf,338 nrArr=21cf " +
  "nrarr=219b nrarrc=2933,338 nrarrw=219d,338 nrightarrow=219b nrtri=22eb nrtrie=22ed nsc=2281 " +
  "nsccue=22e1 nsce=2ab0,338 nscr=1d4c3 nshortmid=2224 nshortparallel=2226 nsim=2241 nsime=2244 " +
  "nsimeq=2244 nsmid=2224 nspar=2226 nsqsube=22e2 nsqsupe=22e3 nsub=2284 nsubE=2ac5,338 nsube=2288 " +
  "nsubset=2282,20d2 nsubseteq=2288 nsubseteqq=2ac5,338 nsucc=2281 nsucceq=2ab0,338 nsup=2285 " +
  "nsupE=2ac6,338 nsupe=2289 nsupset=2283,20d2 nsupseteq=2289 nsupseteqq=2ac6,338 ntgl=2279 " +
  "ntilde!f1 ntlg=2278 ntriangleleft=22ea ntrianglelefteq=22ec ntriangleright=22eb " +
  "ntrianglerighteq=22ed nu=3bd num=23 numero=2116 numsp=2007 nvDash=22ad nvHarr=2904 " +
  "nvap=224d,20d2 nvdash=22ac nvge=2265,20d2 nvgt=3e,20d2 nvinfin=29de nvlArr=2902 nvle=2264,20d2 " +
  "nvlt=3c,20d2 nvltrie=22b4,20d2 nvrArr=2903 nvrtrie=22b5,20d2 nvsim=223c,20d2 nwArr=21d6 " +
  "nwarhk=2923 nwarr=2196 nwarrow=2196 nwnear=2927 oS=24c8 oacute!f3 oast=229b ocir=229a ocirc!f4 " +
  "ocy=43e odash=229d odblac=151 odiv=2a38 odot=2299 odsold=29bc oelig=153 ofcir=29bf ofr=1d52c " +
  "ogon=2db ograve!f2 ogt=29c1 ohbar=29b5 ohm=3a9 oint=222e olarr=21ba olcir=29be olcross=29bb " +
  "oline=203e olt=29c0 omacr=14d omega=3c9 omicron=3bf omid=29b6 ominus=2296 oopf=1d560 opar=29b7 " +
  "operp=29b9 oplus=2295 or=2228 orarr=21bb ord=2a5d order=2134 orderof=2134 ordf!aa ordm!ba " +
  "origof=22b6 oror=2a56 orslope=2a57 orv=2a5b oscr=2134 oslash!f8 osol=2298 otilde!f5 otimes=2297 " +
  "otimesas=2a36 ouml!f6 ovbar=233d par=2225 para!b6 parallel=2225 parsim=2af3 parsl=2afd part=2202 " +
  "pcy=43f percnt=25 period=2e permil=2030 perp=22a5 pertenk=2031 pfr=1d52d phi=3c6 phiv=3d5 " +
  "phmmat=2133 phone=260e pi=3c0 pitchfork=22d4 piv=3d6 planck=210f planckh=210e plankv=210f " +
  "plus=2b plusacir=2a23 plusb=229e pluscir=2a22 plusdo=2214 plusdu=2a25 pluse=2a72 plusmn!b1 " +
  "plussim=2a26 plustwo=2a27 pm=b1 pointint=2a15 popf=1d561 pound!a3 pr=227a prE=2ab3 prap=2ab7 " +
  "prcue=227c pre=2aaf prec=227a precapprox=2ab7 preccurlyeq=227c preceq=2aaf precnapprox=2ab9 " +
  "precneqq=2ab5 precnsim=22e8 precsim=227e prime=2032 primes=2119 prnE=2ab5 prnap=2ab9 prnsim=22e8 " +
  "prod=220f profalar=232e profline=2312 profsurf=2313 prop=221d propto=221d prsim=227e prurel=22b0 " +
  "pscr=1d4c5 psi=3c8 puncsp=2008 qfr=1d52e qint=2a0c qopf=1d562 qprime=2057 qscr=1d4c6 " +
  "quaternions=210d quatint=2a16 quest=3f questeq=225f quot!22 rAarr=21db rArr=21d2 rAtail=291c " +
  "rBarr=290f rHar=2964 race=223d,331 racute=155 radic=221a raemptyv=29b3 rang=27e9 rangd=2992 " +
  "range=29a5 rangle=27e9 raquo!bb rarr=2192 rarrap=2975 rarrb=21e5 rarrbfs=2920 rarrc=2933 " +
  "rarrfs=291e rarrhk=21aa rarrlp=21ac rarrpl=2945 rarrsim=2974 rarrtl=21a3 rarrw=219d ratail=291a " +
  "ratio=2236 rationals=211a rbarr=290d rbbrk=2773 rbrace=7d rbrack=5d rbrke=298c rbrksld=298e " +
  "rbrkslu=2990 rcaron=159 rcedil=157 rceil=2309 rcub=7d rcy=440 rdca=2937 rdldhar=2969 rdquo=201d " +
  "rdquor=201d rdsh=21b3 real=211c realine=211b realpart=211c reals=211d rect=25ad reg!ae " +
  "rfisht=297d rfloor=230b rfr=1d52f rhard=21c1 rharu=21c0 rharul=296c rho=3c1 rhov=3f1 " +
  "rightarrow=2192 rightarrowtail=21a3 rightharpoondown=21c1 rightharpoonup=21c0 " +
  "rightleftarrows=21c4 rightleftharpoons=21cc rightrightarrows=21c9 rightsquigarrow=219d " +
  "rightthreetimes=22cc ring=2da risingdotseq=2253 rlarr=21c4 rlhar=21cc rlm=200f rmoust=23b1 " +
  "rmoustache=23b1 rnmid=2aee roang=27ed roarr=21fe robrk=27e7 ropar=2986 ropf=1d563 roplus=2a2e " +
  "rotimes=2a35 rpar=29 rpargt=2994 rppolint=2a12 rrarr=21c9 rsaquo=203a rscr=1d4c7 rsh=21b1 " +
  "rsqb=5d rsquo=2019 rsquor=2019 rthree=22cc rtimes=22ca rtri=25b9 rtrie=22b5 rtrif=25b8 " +
  "rtriltri=29ce ruluhar=2968 rx=211e sacute=15b sbquo=201a sc=227b scE=2ab4 scap=2ab8 scaron=161 " +
  "sccue=227d sce=2ab0 scedil=15f scirc=15d scnE=2ab6 scnap=2aba scnsim=22e9 scpolint=2a13 " +
  "scsim=227f scy=441 sdot=22c5 sdotb=22a1 sdote=2a66 seArr=21d8 searhk=2925 searr=2198 " +
  "searrow=2198 sect!a7 semi=3b seswar=2929 setminus=2216 setmn=2216 sext=2736 sfr=1d530 " +
  "sfrown=2322 sharp=266f shchcy=449 shcy=448 shortmid=2223 shortparallel=2225 shy!ad sigma=3c3 " +
  "sigmaf=3c2 sigmav=3c2 sim=223c simdot=2a6a sime=2243 simeq=2243 simg=2a9e simgE=2aa0 siml=2a9d " +
  "simlE=2a9f simne=2246 simplus=2a24 simrarr=2972 slarr=2190 smallsetminus=2216 smashp=2a33 " +
  "smeparsl=29e4 smid=2223 smile=2323 smt=2aaa smte=2aac smtes=2aac,fe00 softcy=44c sol=2f " +
  "solb=29c4 solbar=233f sopf=1d564 spades=2660 spadesuit=2660 spar=2225 sqcap=2293 " +
  "sqcaps=2293,fe00 sqcup=2294 sqcups=2294,fe00 sqsub=228f sqsube=2291 sqsubset=228f " +
  "sqsubseteq=2291 sqsup=2290 sqsupe=2292 sqsupset=2290 sqsupseteq=2292 squ=25a1 square=25a1 " +
  "squarf=25aa squf=25aa srarr=2192 sscr=1d4c8 ssetmn=2216 ssmile=2323 sstarf=22c6 star=2606 " +
  "starf=2605 straightepsilon=3f5 straightphi=3d5 strns=af sub=2282 subE=2ac5 subdot=2abd sube=2286 " +
  "subedot=2ac3 submult=2ac1 subnE=2acb subne=228a subplus=2abf subrarr=2979 subset=2282 " +
  "subseteq=2286 subseteqq=2ac5 subsetneq=228a subsetneqq=2acb subsim=2ac7 subsub=2ad5 subsup=2ad3 " +
  "succ=227b succapprox=2ab8 succcurlyeq=227d succeq=2ab0 succnapprox=2aba succneqq=2ab6 " +
  "succnsim=22e9 succsim=227f sum=2211 sung=266a sup1!b9 sup2!b2 sup3!b3 sup=2283 supE=2ac6 " +
  "supdot=2abe supdsub=2ad8 supe=2287 supedot=2ac4 suphsol=27c9 suphsub=2ad7 suplarr=297b " +
  "supmult=2ac2 supnE=2acc supne=228b supplus=2ac0 supset=2283 supseteq=2287 supseteqq=2ac6 " +
  "supsetneq=228b supsetneqq=2acc supsim=2ac8 supsub=2ad4 supsup=2ad6 swArr=21d9 swarhk=2926 " +
  "swarr=2199 swarrow=2199 swnwar=292a szlig!df target=2316 tau=3c4 tbrk=23b4 tcaron=165 tcedil=163 " +
  "tcy=442 tdot=20db telrec=2315 tfr=1d531 there4=2234 therefore=2234 theta=3b8 thetasym=3d1 " +
  "thetav=3d1 thickapprox=2248 thicksim=223c thinsp=2009 thkap=2248 thksim=223c thorn!fe tilde=2dc " +
  "times!d7 timesb=22a0 timesbar=2a31 timesd=2a30 tint=222d toea=2928 top=22a4 topbot=2336 " +
  "topcir=2af1 topf=1d565 topfork=2ada tosa=2929 tprime=2034 trade=2122 triangle=25b5 " +
  "triangledown=25bf triangleleft=25c3 trianglelefteq=22b4 triangleq=225c triangleright=25b9 " +
  "trianglerighteq=22b5 tridot=25ec trie=225c triminus=2a3a triplus=2a39 trisb=29cd tritime=2a3b " +
  "trpezium=23e2 tscr=1d4c9 tscy=446 tshcy=45b tstrok=167 twixt=226c twoheadleftarrow=219e " +
  "twoheadrightarrow=21a0 uArr=21d1 uHar=2963 uacute!fa uarr=2191 ubrcy=45e ubreve=16d ucirc!fb " +
  "ucy=443 udarr=21c5 udblac=171 udhar=296e ufisht=297e ufr=1d532 ugrave!f9 uharl=21bf uharr=21be " +
  "uhblk=2580 ulcorn=231c ulcorner=231c ulcrop=230f ultri=25f8 umacr=16b uml!a8 uogon=173 " +
  "uopf=1d566 uparrow=2191 updownarrow=2195 upharpoonleft=21bf upharpoonright=21be uplus=228e " +
  "upsi=3c5 upsih=3d2 upsilon=3c5 upuparrows=21c8 urcorn=231d urcorner=231d urcrop=230e uring=16f " +
  "urtri=25f9 uscr=1d4ca utdot=22f0 utilde=169 utri=25b5 utrif=25b4 uuarr=21c8 uuml!fc uwangle=29a7 " +
  "vArr=21d5 vBar=2ae8 vBarv=2ae9 vDash=22a8 vangrt=299c varepsilon=3f5 varkappa=3f0 " +
  "varnothing=2205 varphi=3d5 varpi=3d6 varpropto=221d varr=2195 varrho=3f1 varsigma=3c2 " +
  "varsubsetneq=228a,fe00 varsubsetneqq=2acb,fe00 varsupsetneq=228b,fe00 varsupsetneqq=2acc,fe00 " +
  "vartheta=3d1 vartriangleleft=22b2 vartriangleright=22b3 vcy=432 vdash=22a2 vee=2228 veebar=22bb " +
  "veeeq=225a vellip=22ee verbar=7c vert=7c vfr=1d533 vltri=22b2 vnsub=2282,20d2 vnsup=2283,20d2 " +
  "vopf=1d567 vprop=221d vrtri=22b3 vscr=1d4cb vsubnE=2acb,fe00 vsubne=228a,fe00 vsupnE=2acc,fe00 " +
  "vsupne=228b,fe00 vzigzag=299a wcirc=175 wedbar=2a5f wedge=2227 wedgeq=2259 weierp=2118 wfr=1d534 " +
  "wopf=1d568 wp=2118 wr=2240 wreath=2240 wscr=1d4cc xcap=22c2 xcirc=25ef xcup=22c3 xdtri=25bd " +
  "xfr=1d535 xhArr=27fa xharr=27f7 xi=3be xlArr=27f8 xlarr=27f5 xmap=27fc xnis=22fb xodot=2a00 " +
  "xopf=1d569 xoplus=2a01 xotime=2a02 xrArr=27f9 xrarr=27f6 xscr=1d4cd xsqcup=2a06 xuplus=2a04 " +
  "xutri=25b3 xvee=22c1 xwedge=22c0 yacute!fd yacy=44f ycirc=177 ycy=44b yen!a5 yfr=1d536 yicy=457 " +
  "yopf=1d56a yscr=1d4ce yucy=44e yuml!ff zacute=17a zcaron=17e zcy=437 zdot=17c zeetrf=2128 " +
  "zeta=3b6 zfr=1d537 zhcy=436 zigrarr=21dd zopf=1d56b zscr=1d4cf zwj=200d zwnj=200c";

let namedReferences = null;
function namedReference(key) {
  if (namedReferences === null) {
    namedReferences = new Map();
    for (const entry of NAMED_REFERENCE_DATA.split(" ")) {
      const sep = entry.search(/[!=]/);
      const name = entry.slice(0, sep);
      const value = String.fromCodePoint(...entry.slice(sep + 1).split(",").map((h) => parseInt(h, 16)));
      namedReferences.set(name + ";", value);
      if (entry[sep] === "!") namedReferences.set(name, value);
    }
  }
  return namedReferences.get(key);
}

function decodeAttributeValue(value) {
  if (!value.includes("&") && !value.includes("\u0000")) return value;
  const s = value.replace(/\u0000/g, "\uFFFD");
  const n = s.length;
  let out = "";
  let i = 0;
  for (;;) {
    const amp = s.indexOf("&", i);
    if (amp === -1) return out + s.slice(i);
    out += s.slice(i, amp);
    i = amp + 1;
    if (s[i] === "#") {
      let j = i + 1;
      const hex = s[j] === "x" || s[j] === "X";
      if (hex) j++;
      const digits = j;
      let code = 0;
      for (; j < n; j++) {
        const c = s[j];
        const d = c >= "0" && c <= "9" ? c.charCodeAt(0) - 48
          : hex && c >= "a" && c <= "f" ? c.charCodeAt(0) - 87
          : hex && c >= "A" && c <= "F" ? c.charCodeAt(0) - 55
          : -1;
        if (d === -1) break;
        code = Math.min(code * (hex ? 16 : 10) + d, 0x110000);
      }
      if (j === digits) { out += "&"; continue; }
      if (s[j] === ";") j++;
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
      else if (C1_REPLACEMENTS[code]) code = C1_REPLACEMENTS[code];
      out += String.fromCodePoint(code);
      i = j;
      continue;
    }
    // A name is at most 31 letters and digits, so the run is read no further than 32.
    let end = i;
    while (end < n && end - i < 32 && isAsciiAlphanumeric(s[end])) end++;
    let match, matchEnd = -1;
    if (end > i && s[end] === ";") {
      match = namedReference(s.slice(i, end) + ";");
      if (match !== undefined) matchEnd = end + 1;
    }
    for (let k = end; matchEnd === -1 && k > i; k--) {
      match = namedReference(s.slice(i, k));
      if (match !== undefined) matchEnd = k;
    }
    if (matchEnd === -1) { out += "&"; continue; }
    if (s[matchEnd - 1] !== ";" && (s[matchEnd] === "=" || isAsciiAlphanumeric(s[matchEnd]))) { out += "&"; continue; }
    out += match;
    i = matchEnd;
  }
}

// The head is where a real parser says it ends, not where the text "</head>" happens to
// appear. Erik's decision 2026-08-24: the two v2 checks describe what the page's HEAD
// points at, so a link element the parser moves into the body is not one of them. That is
// the strict reading, and it is what the HTML parsing spec's "in head" insertion mode
// does: whitespace, comments, doctype and the head-only elements keep the head open;
// the first text node, the first body-level element and </head>, </body>, </html> or
// </br> close it; any other end tag in the head is a parse error and is ignored.
var HEAD_ELEMENTS = ["base", "basefont", "bgsound", "link", "meta", "noframes", "script", "style", "template", "title", "noscript"];
// Once </head> has been seen the parser is in "after head", and that list is the one above
// WITHOUT noscript: a noscript there opens the body instead of staying in the head.
var AFTER_HEAD_ELEMENTS = ["base", "basefont", "bgsound", "link", "meta", "noframes", "script", "style", "template", "title"];
// Their content is not markup: script, style, title, noscript (a parser with scripting on
// reads it as raw text) and noframes are raw text or RCDATA, and template content is inert.
var HEAD_SKIPPED_CONTENT = ["script", "style", "title", "noscript", "noframes", "template"];

// The end of a raw text or RCDATA element: the first </name that is followed by optional
// whitespace, an optional "/" (a parser closes on </script/> too) and a ">". Returns the
// index after it, or -1 when the element never closes, which means the rest of the
// document is inside it.
function skipSpace(lower, j) {
  while (j < lower.length && (lower[j] === " " || lower[j] === "\t" || lower[j] === "\n" || lower[j] === "\r" || lower[j] === "\f")) j++;
  return j;
}

// True when the character ends a tag name: whitespace, "/", ">" or the end of the input.
function isTagBoundary(c) {
  return c === undefined || c === ">" || c === "/" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

// The index just after "</name ... >", or -1 when that is not an end tag there.
function endTagAt(lower, name, at) {
  if (!lower.startsWith("</" + name, at)) return -1;
  let j = skipSpace(lower, at + name.length + 2);
  if (lower[j] === "/") j = skipSpace(lower, j + 1);
  return lower[j] === ">" ? j + 1 : -1;
}

function rawTextEnd(lower, name, from) {
  for (let at = lower.indexOf("</" + name, from); at !== -1; at = lower.indexOf("</" + name, at + name.length + 2)) {
    const end = endTagAt(lower, name, at);
    if (end !== -1) return end;
  }
  return -1;
}

// script is not plain raw text: <!-- puts the tokenizer in the escaped state, a nested
// <script there puts it in the double escaped state, and in THAT state </script only ends
// the escape, not the element. Without this the legacy shape
// <script><!-- ... <script>...</script> ... --></script> ended early and the rest of the
// script was read as markup, which is the wrong direction. 4 of 240 000 fuzz inputs.
function scriptEnd(lower, from) {
  let i = from, escaped = false, doubleEscaped = false;
  while (i < lower.length) {
    if (lower.startsWith("<!--", i)) { escaped = true; i += 4; continue; }
    if (escaped && lower.startsWith("-->", i)) { escaped = false; doubleEscaped = false; i += 3; continue; }
    if (escaped && !doubleEscaped && lower.startsWith("<script", i) && isTagBoundary(lower[i + 7])) { doubleEscaped = true; i += 7; continue; }
    if (lower.startsWith("</script", i)) {
      if (doubleEscaped) { doubleEscaped = false; i += 8; continue; }
      const end = endTagAt(lower, "script", i);
      if (end !== -1) return end;
      i += 8;
      continue;
    }
    const next = lower.indexOf("<", i + 1);
    i = next === -1 ? lower.length : next;
  }
  return -1;
}

// The end of a nested template: templates count, so an inner </template> does not close
// an outer one. Returns the index after the closing tag, or -1 when it never closes.
function templateEnd(lower, from) {
  let depth = 1;
  // Both searches resume from their own previous hit. Restarting either one from a shared
  // cursor is quadratic: "</templateX" repeated made every round scan to the end of the
  // input again, and 1 MB of it measured 15 686 ms.
  let open = lower.indexOf("<template", from);
  let close = lower.indexOf("</template", from);
  for (;;) {
    if (close === -1) return -1;
    if (open !== -1 && open < close) {
      if (isTagBoundary(lower[open + 9])) depth++;
      open = lower.indexOf("<template", open + 9);
      continue;
    }
    let j = close + 10;
    j = skipSpace(lower, j);
    if (lower[j] === "/") j = skipSpace(lower, j + 1);
    if (lower[j] !== ">") {
      // Not an end tag: for the tokenizer the rest of the name runs to the next ">", and a
      // "<" inside it is part of the name rather than a new tag.
      const bogus = lower.indexOf(">", close + 10);
      if (bogus === -1) return -1;
      close = lower.indexOf("</template", bogus + 1);
      if (open !== -1 && open < bogus) open = lower.indexOf("<template", bogus + 1);
      continue;
    }
    depth--;
    if (depth === 0) return j + 1;
    close = lower.indexOf("</template", j + 1);
  }
}

// The index after the "-->" or "--!>" that ends a comment whose text starts at from, or -1 when
// the comment never ends. One forward pass over the "--" pairs. The earlier code searched for
// "--!>" separately from every comment, and on a page that never uses that ending, which is
// almost every page, each search ran to the end of the document: 100 KB of short comments
// measured 770 ms and each doubling took four times as long (found by a verifier, 2026-09-12).
function commentEnd(lower, from) {
  for (let p = lower.indexOf("--", from); p !== -1; p = lower.indexOf("--", p + 1)) {
    if (lower[p + 2] === ">") return p + 3;
    if (lower[p + 2] === "!" && lower[p + 3] === ">") return p + 4;
  }
  return -1;
}

// One left to right scan by index that returns the head, with comments and the content of
// the raw text and template elements already removed. Why a scan and not a regex: a
// character class that reads a tag's attributes is quadratic on input the TARGET site
// controls (CodeQL js/polynomial-redos, alerts #4 and #5, 2026-08-24), and bounding the
// class trades that speed bug for a worse correctness bug, because an open tag longer than
// the bound stops being recognised and the element's own text is then read as markup. A
// scan has no bound and no backtracking, and it visits every character once.
//
// The shapes, all measured against a real HTML parser (parse5) rather than reasoned about.
// An unterminated <!-- comments out the rest of the document. <!--> and <!---> are EMPTY
// comments, not unterminated ones, and --!> ends a comment as well. A "<" that no letter,
// "!", "/" or "?" follows is text. A ">" inside a quoted attribute value does not end a
// tag. </script/> closes a raw text element as well as </script> does.
function headOfDocument(html) {
  // A parser tokenizes an input stream whose CRLF and CR have already become LF, so a value read
  // from the head carries LF where the page wrote CR (measured against parse5, 2026-09-12).
  const text = String(html || "").replace(/\r\n?/g, "\n");
  const lower = asciiLower(text);
  const out = [];
  let i = 0, afterHead = false;
  for (;;) {
    const lt = lower.indexOf("<", i);
    const gap = lt === -1 ? text.slice(i) : text.slice(i, lt);
    if (!isHtmlWhitespace(gap)) break;
    out.push(gap);
    if (lt === -1) break;
    if (lower.startsWith("<!--", lt)) {
      if (lower.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (lower.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const end = commentEnd(lower, lt + 4);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (!startsTag(lower[lt + 1])) break;
    // "<!", "<?" and a "</" that no letter follows open a bogus comment or a doctype, and the
    // tokenizer ends each of them at the first ">", inside quotes or not.
    if (lower[lt + 1] === "!" || lower[lt + 1] === "?" || (lower[lt + 1] === "/" && !(lower[lt + 2] >= "a" && lower[lt + 2] <= "z"))) {
      const bogusEnd = lower.indexOf(">", lt + 2);
      if (bogusEnd === -1) break;
      i = bogusEnd + 1;
      continue;
    }
    const gt = tagEnd(text, lt);
    if (gt === -1) break;
    const head14 = lower.slice(lt, Math.min(lt + 14, gt + 1));
    if (lower[lt + 1] === "/") {
      // The name has to END where a tag name ends: </bodyx> is an unknown end tag, which the
      // head ignores, and not </body>.
      const endTag = (/^<\/([a-z]+)(?=[\t\n\f\r />]|$)/.exec(head14) || [])[1];
      // </body>, </html> and </br> start the body. </head> does NOT end the search: after
      // it a parser still puts base, link, meta, script, style, title and template into the
      // HEAD element until real body content starts, and every other end tag in the head is
      // a parse error that is ignored. Measured against parse5: without this, 2 660 of
      // 200 000 fuzz inputs lost a relation the head really carries.
      if (endTag === "body" || endTag === "html" || endTag === "br") break;
      if (endTag === "head") afterHead = true;
      i = gt + 1;
      continue;
    }
    const name = (/^<([a-z]+)(?=[\t\n\f\r />]|$)/.exec(head14) || [])[1];
    if (!name) break;
    if (name === "html" || name === "head") { i = gt + 1; continue; }
    if (!(afterHead ? AFTER_HEAD_ELEMENTS : HEAD_ELEMENTS).includes(name)) break;   // <body> and the first body level element
    if (HEAD_SKIPPED_CONTENT.includes(name)) {
      const end = name === "template" ? templateEnd(lower, gt + 1)
        : name === "script" ? scriptEnd(lower, gt + 1)
        : rawTextEnd(lower, name, gt + 1);
      if (end === -1) break;
      i = end;
      continue;
    }
    out.push(text.slice(lt, gt + 1));
    i = gt + 1;
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
  const lower = asciiLower(text);
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

function tagAttributes(tag) {
  const out = {};
  readTag(tag, 0, out);
  return out;
}

// RFC 8288 section 3: a Link header is a comma separated list, each value an angle
// bracketed URI reference followed by semicolon separated parameters, and a parameter
// value may be a quoted string that contains commas, semicolons and backslash escapes.
// Reading rel and type with one regex over the whole value read the CONTENT of
// title="note; rel=alternate; type=text/markdown" as parameters of the link.
function parseLinkHeader(header) {
  const s = String(header || "");
  const space = " \t";
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    while (i < n && (s[i] === "," || space.includes(s[i]))) i++;
    if (i >= n) break;
    if (s[i] !== "<") { i = nextLinkValue(s, i); continue; }
    const gt = s.indexOf(">", i + 1);
    if (gt === -1) break;
    const href = s.slice(i + 1, gt).trim();
    i = gt + 1;
    const params = {};
    while (i < n) {
      while (i < n && space.includes(s[i])) i++;
      if (i >= n) break;
      if (s[i] === ",") { i++; break; }
      if (s[i] !== ";") { i = nextLinkValue(s, i); break; }
      i++;
      while (i < n && space.includes(s[i])) i++;
      const nameStart = i;
      while (i < n && s[i] !== "=" && s[i] !== ";" && s[i] !== "," && !space.includes(s[i])) i++;
      const name = asciiLower(s.slice(nameStart, i));
      while (i < n && space.includes(s[i])) i++;
      let value = "";
      if (s[i] === "=") {
        i++;
        while (i < n && space.includes(s[i])) i++;
        if (s[i] === '"') {
          i++;
          let buf = "";
          while (i < n && s[i] !== '"') {
            if (s[i] === "\\" && i + 1 < n) { buf += s[i + 1]; i += 2; continue; }
            buf += s[i];
            i++;
          }
          if (i < n) i++;
          value = buf;
        } else {
          const valueStart = i;
          while (i < n && s[i] !== ";" && s[i] !== "," && !space.includes(s[i])) i++;
          value = s.slice(valueStart, i);
        }
      }
      if (name && !(name in params)) params[name] = value;
    }
    out.push({ href: href, params: params });
  }
  return out;
}

// Move to the start of the next comma separated value without stopping inside a quoted
// string, so a comma in title="a, b" does not split one value into two.
function nextLinkValue(s, from) {
  let quote = "";
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === "\\") { j++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"') { quote = c; continue; }
    if (c === ",") return j + 1;
  }
  return s.length;
}

// v2 of the llms.txt proposal (August 2026) left the file format alone and added one
// thing: a page should say where its markdown version and its llms.txt are, using
// rel="alternate" type="text/markdown" and rel="describedby", as HTML link elements or
// as a Link response header. That is a property of the site, not of the file, so these
// two carry their own status, "info". They are never a warn and never a fail, the
// summary line is unchanged, and --strict keeps exiting on warnings only.
export function findLinkRelations(html, linkHeader) {
  const found = { describedby: null, markdown: null };
  // Only the head, and only what a parser would put there: a commented-out link element,
  // one inside a script or a template, and one the parser moves into the body are all not
  // what these two checks are about, and counting them would report a relation the site
  // does not serve. See headOfDocument above for the rules shape by shape.
  // The scan reads only the first 65,536 UTF-16 code units of what headOfDocument returns.
  // The cap applies after the head is collected, so it bounds this tag scan and not the head
  // parse, and a relation declared past it is not found here. The Link response header is
  // read separately below.
  const head = headOfDocument(html).slice(0, 65536);
  for (const tag of htmlTags(head)) {
    // The name has to END at "link": a real parser reads "<link<link" as ONE tag whose
    // NAME is "link<link", not as a link element, so \b would count a relation the site
    // does not publish. Measured against parse5, 2026-08-24.
    if (!/^<link(?=[\t\n\f\r />])/i.test(tag)) continue;
    // Attributes come from ONE quote aware scan, not from three independent regex matches
    // over the whole tag. Those three could not tell an attribute from the quoted CONTENT
    // of another attribute, so data-note=" rel='alternate' type='text/markdown'
    // href='/fake.md'" reported a relation the page does not publish. The earlier
    // data-rel fix, 2026-08-29, moved the START of the name and does not reach this.
    // Measured and fixed 2026-09-09.
    const attrs = tagAttributes(tag);
    const rel = trimChars(asciiLower(attrs.rel || ""), HTML_WHITESPACE).split(/[\t\n\f\r ]+/);
    const type = trimChars(asciiLower(attrs.type || ""), HTTP_WHITESPACE);
    const href = trimChars(attrs.href || "", HTML_WHITESPACE);
    // text/markdown, not anything that starts with it, and a relation without a target is
    // not a relation: both passed until 2026-08-29.
    const isMarkdown = trimChars(type.split(";")[0], HTTP_WHITESPACE) === "text/markdown";
    if (!found.describedby && href && rel.includes("describedby")) found.describedby = href;
    if (!found.markdown && href && rel.includes("alternate") && isMarkdown) found.markdown = href;
  }
  for (const link of parseLinkHeader(linkHeader)) {
    const href = link.href;
    const rel = trimChars(asciiLower(link.params.rel || ""), HTTP_WHITESPACE).split(/[\t\n\r ]+/);
    const type = trimChars(asciiLower(link.params.type || ""), HTTP_WHITESPACE);
    const isMarkdownHeader = trimChars(type.split(";")[0], HTTP_WHITESPACE) === "text/markdown";
    if (!found.describedby && href && rel.includes("describedby")) found.describedby = href;
    if (!found.markdown && href && rel.includes("alternate") && isMarkdownHeader) found.markdown = href;
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
    found.describedby ? 'rel="describedby" to ' + cut(found.describedby, 120) : 'no rel="describedby" in the head or the Link header; v2 recommends it so an agent finds the file without guessing');
  add("v2-markdown-alternate", found.markdown ? "pass" : "info", "Home page points to a markdown version (v2)",
    found.markdown ? 'rel="alternate" type="text/markdown" to ' + cut(found.markdown, 120) : 'no rel="alternate" type="text/markdown" in the head or the Link header; v2 recommends it so an agent finds the markdown form without guessing');
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
    throw new Error("not a public domain name: " + cut(input, 120));
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

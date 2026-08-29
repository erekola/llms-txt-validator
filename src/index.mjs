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
  const firstRaw = firstIdx === -1 ? "" : lines[firstIdx];
  const first = firstRaw.trim();
  // The line is read as markdown and not trimmed first. Four spaces or a tab make it an
  // indented code block rather than a heading, and trimming erased that difference, so
  // "    # Site" passed as the H1 until 2026-08-29. CommonMark allows three spaces.
  if (/^ {0,3}# \S/.test(firstRaw)) {
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
  // A section counts when it carries a file list. An H2 followed by a paragraph satisfied
  // this check until 2026-08-29, and the format puts each section's links in a list.
  let sectionsWithList = 0;
  {
    let inSection = false, counted = false;
    for (const l of lines) {
      if (/^## /.test(l)) { inSection = true; counted = false; continue; }
      if (/^# /.test(l)) { inSection = false; continue; }
      if (inSection && !counted && /^ {0,3}[-*+] .*\[[^\][]*\]\([^)\s]+\)/.test(l)) { sectionsWithList++; counted = true; }
    }
  }
  if (h2Count > 0 && sectionsWithList > 0) {
    add("sections", "pass", "H2 sections group the content", h2Count + " section" + (h2Count === 1 ? "" : "s") + ", " + sectionsWithList + " carrying a file list");
  } else if (h2Count > 0) {
    add("sections", "warn", "H2 sections group the content", h2Count + " section" + (h2Count === 1 ? "" : "s") + " but no file list under any of them; the format puts a section's links in a markdown list");
  } else {
    add("sections", "warn", "H2 sections group the content", "no H2 sections found; sections are the convention for grouping links");
  }
  const links = [...f.text.matchAll(/\[([^\][]*)\]\(([^)\s]{1,2048})\)/g)];
  // An entry an agent can use has a name and a target with a host. An empty name and a
  // bare "https://" both counted as valid absolute links until 2026-08-29.
  const named = links.filter((m) => m[1].trim() !== "");
  const unnamed = links.length - named.length;
  const absolute = named.filter((m) => /^https?:\/\/[^/\s?#]+/.test(m[2])).length;
  if (links.length === 0) {
    add("links", "warn", "Markdown links an agent can follow", "no markdown links found");
  } else if (unnamed > 0) {
    add("links", "warn", "Markdown links an agent can follow", links.length + " link" + (links.length === 1 ? "" : "s") + ", " + unnamed + " with an empty link name; an entry needs a name an agent can show");
  } else if (absolute === named.length) {
    add("links", "pass", "Markdown links an agent can follow", named.length + " link" + (named.length === 1 ? "" : "s") + ", all absolute URLs");
  } else {
    const relativeCount = named.filter((m) => !/^[a-z][a-z0-9+.-]*:/i.test(m[2])).length;
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
  const text = String(html || "");
  const lower = text.toLowerCase();
  const out = [];
  let i = 0, afterHead = false;
  for (;;) {
    const lt = lower.indexOf("<", i);
    const gap = lt === -1 ? text.slice(i) : text.slice(i, lt);
    if (gap.trim() !== "") break;
    out.push(gap);
    if (lt === -1) break;
    if (lower.startsWith("<!--", lt)) {
      if (lower.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (lower.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const dashes = lower.indexOf("-->", lt + 4);
      const bang = lower.indexOf("--!>", lt + 4);
      if (dashes === -1 && bang === -1) break;
      i = (bang === -1 || (dashes !== -1 && dashes <= bang)) ? dashes + 3 : bang + 4;
      continue;
    }
    if (!startsTag(lower[lt + 1])) break;
    const gt = tagEnd(text, lt);
    if (gt === -1) break;
    if (lower[lt + 1] === "!" || lower[lt + 1] === "?") { i = gt + 1; continue; }
    const head14 = lower.slice(lt, Math.min(lt + 14, gt + 1));
    const endTag = (/^<\/([a-z]+)/.exec(head14) || [])[1];
    if (endTag) {
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
    const name = (/^<([a-z]+)(?=[\s/>]|$)/.exec(head14) || [])[1];
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
  // Only the head, and only what a parser would put there: a commented-out link element,
  // one inside a script or a template, and one the parser moves into the body are all not
  // what these two checks are about, and counting them would report a relation the site
  // does not serve. See headOfDocument above for the rules shape by shape. The 64 KB bound
  // is a cap on work, not a rule: a head longer than that is not a head.
  const head = headOfDocument(html).slice(0, 65536);
  for (const tag of htmlTags(head)) {
    // The name has to END at "link": a real parser reads "<link<link" as ONE tag whose
    // NAME is "link<link", not as a link element, so \b would count a relation the site
    // does not publish. Measured against parse5, 2026-08-24.
    if (!/^<link(?=[\s/>])/i.test(tag)) continue;
    // The attribute name has to start the token. \b sits between the hyphen and the name,
    // so data-rel, data-type and data-href were read as the real attributes until
    // 2026-08-29, and a page could claim a relation it does not publish.
    const rel = ((tag.match(/(?:^|[\s/])rel\s*=\s*["']?([^"'>]+)/i) || [])[1] || "").toLowerCase().trim().split(/\s+/);
    const type = ((tag.match(/(?:^|[\s/])type\s*=\s*["']?([^"'>\s]+)/i) || [])[1] || "").toLowerCase();
    const href = ((tag.match(/(?:^|[\s/])href\s*=\s*"([^"]*)"|(?:^|[\s/])href\s*=\s*'([^']*)'|(?:^|[\s/])href\s*=\s*([^\s"'>]+)/i) || []).slice(1).find((x) => x !== undefined) || "").trim();
    // text/markdown, not anything that starts with it, and a relation without a target is
    // not a relation: both passed until 2026-08-29.
    const isMarkdown = type.split(";")[0].trim() === "text/markdown";
    if (!found.describedby && href && rel.includes("describedby")) found.describedby = href;
    if (!found.markdown && href && rel.includes("alternate") && isMarkdown) found.markdown = href;
  }
  for (const part of String(linkHeader || "").split(/,(?=\s*<)/)) {
    const lt = part.indexOf("<");
    const gt = lt === -1 ? -1 : part.indexOf(">", lt + 1);
    const href = (gt === -1 ? "" : part.slice(lt + 1, gt)).trim();
    const rel = ((part.match(/(?:^|[;\s])rel\s*=\s*"?([^";,]+)"?/i) || [])[1] || "").toLowerCase().trim().split(/\s+/);
    const type = ((part.match(/(?:^|[;\s])type\s*=\s*"?([^";,]+)"?/i) || [])[1] || "").toLowerCase().trim();
    const isMarkdownHeader = type.split(";")[0].trim() === "text/markdown";
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

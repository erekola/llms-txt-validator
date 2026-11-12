# turva-llms-txt-validator changelog

## 0.7.3 (2026-11-12)
This release closes a gap in the exported function `fetchLlmsTxt`. The function checked every redirect target for a public host name, but it did not check the host it was given, so a program that called it directly with `127.0.0.1`, `localhost` or `10.0.0.1` made the first request to that address. `validateHost`, which the command line uses, already refused such a host before it called the function, so the command line and the checks are unchanged.

- `fetchLlmsTxt` now reads its host argument the way `validateHost` does, with `normalizeHostInput` and then `isValidPublicHost`, before any request. A host that fails returns the same result the redirect guard returns for an unsafe target (`redirect: true`, `reason: "unsafe-target"`), with status `0` and an empty location, and `fetch` is not called. A public host name is fetched as before, in its normalised form: `Example.com` and `example.com.` are fetched as `example.com`, and `münchen.de` as its punycode name, so a direct caller gets the same accept or refuse answer as `validateHost`.
- When `validateLlmsTxt` is given that refusal, the http-status check now says that the host is not a public domain name and that no request was made, where it would have printed empty parentheses. Every other redirect message is unchanged.
- The check reads the shape of the name only, by the same rule as `validateHost`: it refuses IP literals, bracketed IPv6, ports other than 80 and 443, credentials and the internal-use endings such as `.local`. It does not resolve the name, so a public name that points at a private address still passes it. The README states the same limit, and this release does not claim that private addresses are refused.
- Test change: a regression test calls the function with `127.0.0.1`, `localhost`, `10.0.0.1`, `[::1]` and `intranet.local` and a stubbed `fetch`, and expects the refusal and zero calls, and a public host still calls `fetch` once. A second test checks that the upper-case, trailing-dot and raw IDN forms reach `fetch` in their normalised form.

## 0.7.2 (2026-11-10)
This release closes a gap that the 0.7.1 entry below describes as closed. 0.7.1 removed a tab, a carriage return or a line feed from the typed address in the function that reads the host, but the function that reads the path still received the address as typed, so the statement that the difference was closed held for the host and not for the path. The compiled package changes in two places: the path function, and an internal function that nothing called is removed. The checks, their results, the summary and the exit code are unchanged for every address except the one in the first item below.

- `ht<TAB>tps://example.com`, `https:<LF>//example.com` and the same with a carriage return validated example.com in 0.7.1 and also gained an information row, "Path in the address you entered", with the value `//example.com`. The function that finds the typed path read the address before the three characters were removed, so the scheme test did not match and the URL parser read the text as a path. The function now removes tab, CR and LF first, as the host function and the hosted validator do, and these addresses carry no path row. The 0.7.1 entry said the difference to the hosted validator was closed; for this one case it was not.
- An internal function that skipped whitespace was never called and is removed. Its comment, which describes the raw text scan, is back above the scan it belongs to.
- Test changes: the publish workflow test compares the value of each permission and not only its name, so `contents: write` in the test or build job fails, as does `id-token: read` in the publish job, and each case has a broken copy of the workflow that the test must reject. One test name now says what the test checks, a test host name is English, and the comment on the two shared test bodies says what differs from the hosted tests.

## 0.7.1 (2026-11-07)
This release closes one difference from the hosted validator. The usage text now names a flag that it already accepted, and the tests that assert a scan stays linear now compare how the time grows. The checks and their results are unchanged for every address except the one in the first item below, and the links check now words a single relative link as "1 link".

- A tab, a carriage return or a line feed anywhere in the typed address is removed before the address is read, as the hosted validator does. `ht<TAB>tps://example.com` and `https:<LF>//example.com` validate example.com. Until now the scheme test ran first and did not match, so the whole text was read as a host name and the run ended in "not a public domain name". Tabs and line breaks elsewhere in the address gave the same result as before, because the URL parser removes them.
- The links check says "1 link, 1 relative" for a single relative link, as its other results already said "1 link". The hosted validator changed the same way.
- `-h` already worked, but neither the usage text nor the README named it. The usage text now lists `--help, -h` and `--version, -V`, and the README option table lists `--help, -h`.
- The tests that assert a scan stays linear used to compare one timing against a limit of 20 times for four times the input. A quadratic scan grows 16 times for that input, so it passed. Other tests used a fixed number of milliseconds, which a slow runner fails. Each of these tests now times two input sizes several times, keeps the fastest run of each size and fails when the ratio is above the geometric midpoint between linear and quadratic growth. For four times the input that limit is 8, and for eight times the input it is about 22.6. The one test whose input is quadratic in its parameter (nested code span pairs, 24.3 times the characters) passes its own limit of twice the size ratio, about 48.7, because the shared limit would be about 120 there and would let a rescan per pair pass. The check is in `test/growth.ts`.
- Test fixes:
  - The H1 cut test now puts the surrogate pair at the last kept position.
  - In the head-only test, the only describedby link in the document is in the body, and the test checks that it is not read.
  - The redirect-body test covers every refusal reason.
  - The CLI tests find `bin/cli.js` from the test file instead of the working directory.
  - The network-error test checks that the target has a masked query.
  - The `-h` flag is tested.
  - A test checks the line numbers of a many-link document.
  - Test names and header comments that did not say what the test does were reworded.

## 0.7.0 (2026-11-05)
Changes to the checks and to the discovery lines, mirrored from the hosted validator as of site 3.224.0. This release changes which files pass in both directions. The changes come from an outside read of this repository, repeated against the current code before each fix. The README list of read forms covers the Markdown rules, one by one.

Reading links and file lists:

- A target keeps balanced parentheses, so `docs_(v2)` is read whole. A target or a definition destination with an unbalanced parenthesis is not a link.
- An empty target, `[a]()` or `[a](<>)`, is a link with an empty target and counts as relative, in a paragraph too. The list note no longer calls it "not a Markdown link".
- A bracket inside a code span neither closes nor breaks a label. `` [`Array[T]` reference](url) `` is a link and `` [not a `link](url`) `` is not. Text inside a code span no longer starts the "looks like a link entry" note.
- A label ends where its paragraph ends. A heading, a bullet or a number starting at 1, a quote, a fence, a thematic break or a setext underline that can interrupt the paragraph means there is no link.
- A link inside the description text of an image is not a link. A reference image whose label has a definition is skipped.
- A link reference definition opens only where a block starts, for example after a blank line, a heading, a fence or a thematic break, at the start of a quote, as a list item or right after another definition. A line that continues a paragraph or a list item is not a definition, and a definition line no longer starts the note.
- A shortcut reference is found after a colon in the same line and after an inline target that did not parse.
- Labels match by Unicode case folding, so `ẞ` and `SS` are one label. Label white space folds as ASCII only.
- A character reference in a target needs its semicolon, so `https&#58//` stays as written. The Link header and the HTML reading keep their own decoding.
- A no-break or ideographic space is part of a target. Only an ASCII space, a tab or another control character ends one.
- Indented code inside a list item no longer counts as a file list: five or more spaces after the marker, or six columns after a blank line under `- item`. The link still counts as a link.
- The lines of a raw HTML block, types 1 to 7 of CommonMark, hold no links, definitions or list items when the block starts at the start of a line outside quotes and list items. The no-HTML check still reads them.
- A block quote line ends a paragraph for backtick pairing. A pair inside one quote still pairs.

Titles and summaries:

- A thematic break, a link reference definition or an HTML line over a run of `=` no longer makes a setext title.
- A title, a link name or a summary whose text is only character references to white space, code spans of white space or empty quote markers counts as empty: `# &#32;`, `[&#32;](url)`, `>>` and `> >`.
- A line that holds only a no-break or ideographic space is not a blank line, so it can no longer stand in front of the H1.

Fetching and discovery:

- A redirect to the same site with one trailing dot in the host is followed. A second dot still fails.
- A `-->` closes the escaped state of a script, so a `<script>` in its text after a closed comment no longer hides the real end tag. `</scriptX>` no longer ends the double escaped state.
- End tags with attributes, such as `</script data-x>` and `</template data-x>`, end their element. A quoted `>` inside the end tag does not end the tag.
- Template scanning reads every tag whole, so a quoted `<` or `>` in an attribute is not markup, `title="<!--"` included. A bogus comment ends at the first `>`.
- Inside `<svg>` and `<math>` in a template, title, script and style are not raw text, except at the HTML integration points such as `foreignObject` and `mtext`. A self-closing `<svg/>` opens nothing. `<plaintext>` in a template makes the rest of the document text.
- White space before the head and after `</head>` no longer counts against the 65,536 character head limit. White space inside the head still does.
- A Link header value with a non-empty `anchor` that does not resolve to the home page is not used. `findLinkRelations` takes an optional fourth argument with the home page addresses, and without it an anchored value is not used. These discovery lines stay info and move no summary and no exit code.

Hostile input stays fast: hostile files at the 256 KiB read limit each ran in under 0.2 seconds in two independent runs.

Tests: new boundary tests at 51,200 and 262,144 bytes, a body in chunks, a timeout, home page errors and the CLI's `--json`, result line and exit codes. Two fixtures that passed for an unrelated reason now carry an href and a tab before `>`.

## 0.6.1 (2026-11-04)
One change to the checks, mirrored from the hosted validator as of site 3.222.0. This release changes which files pass in both directions.

The validator now has one reading of a fence, the same for every check. When a fence was opened on a list marker line, or indented past three columns inside a list item, its closing line at 0 to 3 columns read as a new opening fence, and the lines after it were skipped until the next fence. Those lines now count, unless the closing line sits left of the item's content column, where CommonMark also ends the item and opens a new fence. An unclosed fence inside a list item now ends when the item closes. In a nested list, a line after a blank line or a fence now counts when it is indented to the content column of any item still open. The link and section counts were compared with commonmark.js 0.31.2.

## 0.6.0 (2026-11-04)
Two changes to the checks, mirrored from the hosted validator as of site 3.221.0, and one change to the test matrix. This release changes which files pass in both directions, and it changes the wording of the sentences the validator wrote with a semicolon, except the two v2 discovery information lines.

Backtick pairs are now read closer to how CommonMark reads blocks. A heading line is a block of its own, so its backtick no longer pairs with the next line. An empty list item and a numbered item that does not start at 1 no longer end a paragraph. A backtick pair across such a line is now inline code, and a link inside it does not count. If such a line closes an open list item, it still starts a new item there. Thematic breaks and setext underlines now end a paragraph too. A fence indented past three columns inside a list item now hides what it holds, closed or not, in either fence character, as long as it sits less than four columns past the item's content column. Further in, CommonMark reads indented code, and this validator still counts a link in it. The link counts were compared with commonmark.js 0.31.2. Block quotes and HTML blocks are still not read as blocks here.

An older gap now shows more often. When a fence is opened on a list marker line, at four or more columns or by a tab, its closing line at 0 to 3 columns reads as a new opening fence, and the lines after it are skipped until the next fence. Earlier versions counted a link inside the first fence, and that count could mask the gap, so such a file can now warn that it has no links or no file list.

The sentences the validator writes in a check's detail no longer hold a semicolon, with one exception: the details of the two v2 discovery checks, `v2-describedby` and `v2-markdown-alternate`, still end in a clause after a semicolon that begins `v2 recommends it` when they are information lines. Everywhere else a sentence break stands there now, as in `no H2 sections found. Sections are the convention for grouping links`. This moves no status. A script that matches a detail as text has to follow, and `id` and `status` are the fields to read.

GitHub Actions now also tests Node.js 26 on Ubuntu, so the matrix runs Node.js 22, 24 and 26 on Ubuntu and Node.js 22 on Windows.

## 0.5.1 (2026-11-04)
Four changes to the checks, mirrored from the hosted validator as of site 3.220.0. This release changes which files pass in both directions.

A backtick that opens in one block and finds its match only in another block no longer uses up the closing backtick. Before, a stray backtick in one paragraph or list item moved the pairing by one, so a link inside the next real inline code span could count as a link and text after it could be read as code. Now the closing backtick stays free to open a span of its own in its own block. A file with a link inside inline code that follows a stray backtick in another block no longer gets credit for that link, so it can move from pass to warn on the links check. A file with a relative link inside inline code that follows a stray backtick in another block no longer warns about that relative link, and a real link that the shifted pairing had read as code now counts, so such files can move from warn to pass. A link inside inline code still does not count as a link in either case.

The note on the links check now has two kinds, each with its own sentence, its count and its first five line numbers. A list line whose entry has an unclosed destination reads "looks like a link entry but is not a Markdown link". A list line that opens with an en dash, an em dash or a bullet reads "opens with a dash or bullet that is not a Markdown list marker", even when its link parses and is counted as a link. The earlier sentence "so an agent will not follow it" is gone, because nothing here measures how agents treat such lines. The status and the files that warn are unchanged.

When the home page is cut at the 256 KiB read limit and no relation is found in the part that was read, the two discovery info lines say "in the first 256 KiB of the home page, the part that was read, or in the Link header". They stay info and move no summary and no exit code. A head that is itself over 65,536 characters keeps its own wording.

The size note for a file cut at the read limit now says "over 256 KiB, read truncated" instead of "over 256 KB". Only the unit in the text changes. The limit is 262,144 bytes and the status stays warn.

## 0.5.0 (2026-10-31)

Two changes to the checks, both mirrored from the hosted validator.

The HTML check no longer warns on angle brackets inside code. Inline code spans, fenced code and backslash-escaped angle brackets are blanked before the file is read for tags, so `https://example.com/models/<endpoint-id>/llms.txt` in a code span, `submit_<form>_form` and an escaped `\<node-name\>` pass. A real tag, a closing tag or a comment start in prose still warns, and an autolink is still not a tag.

The links check now warns when a list line under an H2 looks like a link entry but is not a Markdown link. Real llms.txt files show two shapes: an entry whose destination is not closed, such as `- [Name](https://example.com/a.md: notes)`, and an entry that starts with an en dash, an em dash or a bullet instead of a list marker. The warning is part of the existing links check, so the check count and the JSON shape are the same. Its detail names the count and the first five line numbers. A valid entry does not warn, with or without notes after the link. Neither does a task list box.

## 0.4.3 (2026-10-24)

The README gains a section on the move from JavaScript to TypeScript in 0.4.0 and the two fixes in 0.4.1. No code changed. The compiled files differ from 0.4.2 only in comments, which now name src/worker.ts and the .test.ts files of the hosted validator.

## 0.4.2 (2026-10-21)

The README is rewritten for the TypeScript package. It documents `validateHost` and its result types with a TypeScript example, and it adds sections on the release process and on local development. The sample output is the command-line output of a run on 2026-10-21. No code changed. The compiled files are the same as in 0.4.1.

## 0.4.1 (2026-10-21)

Two inputs that neither `fetchLlmsTxt` nor `validateHost` produces no longer leave `undefined` in a
check's detail. With no reason given, `validateV2Discovery` called with null now gives both v2 checks
the detail "the home page was not read, so this was not measured". Given a `redirectedFrom` without a
`finalUrl`, `validateLlmsTxt` now reports "HTTP 200, followed a redirect from" and the masked address it
was redirected from, where it used to end in "to undefined". Results for what `fetchLlmsTxt` and
`validateHost` return do not change, because `fetchLlmsTxt` always sets both fields and `validateHost`
always passes a reason. The hosted validator carries the same change. Two new tests cover the two inputs.

## 0.4.0 (2026-10-21)

The source is now TypeScript, compiled with tsc to dist/, and the package ships its type declarations.
Behind the same `exports` name, the entry point moved to dist/src/index.js. The `llms-txt-validate`
command keeps its flags, its output and its exit codes, and Node.js 22 stays the minimum.

No check logic changed. Compiled dist/src/index.js has the same 12 493 JavaScript tokens as
src/index.mjs in 0.3.21, except the relative path to package.json, which is one directory deeper. The
CLI differs in the same path and in its import of the library. A differential run compared 0.3.21
with 0.4.0 on 4 160 000 generated llms.txt inputs, 832 000 HTML heads with Link headers, 29 120
stubbed fetch scenarios for each of the two network functions and 445 CLI runs, and found no
difference. The same comparison caught both changes planted in copies as a control.

A new test, test/no-javascript.test.ts, fails if a .js, .mjs or .cjs file appears outside node_modules,
dist and .git.

## 0.3.21 (2026-10-05)

This release changes no check result. It replaces the end-marker regular expressions of the HTML block reader
with plain lowercase substring markers, so a code scanner that models them as an HTML tag filter no longer
reports them (CodeQL js/bad-tag-filter). The reader is a CommonMark structural reader and not a sanitizer:
an HTML comment block ends at `-->` only, as CommonMark defines it, so `--!>` is deliberately not an end
marker. The set of files that pass is the same as in 0.3.20. A differential run of 600 000 random lines
over every start and end pair found no difference between the old and the new matching. The hosted validator
carries the same change.

## 0.3.20 (2026-10-03)

This release is one repair from an outside re-check of 2026-10-03, tracked as Tek-565, made in the hosted
validator first and mirrored here. The hosted validator gets the same change in site 3.203.2. It narrows
which files pass the sections check. A file with a second H1 written as a setext heading right after an
indented code line, which was `valid` before, is now `valid with warnings`, and under `--strict` it exits 1.

- A line indented four columns or more that does not continue a paragraph is an indented code block in
  CommonMark. Text after it starts a new paragraph. A second H1 written as a line of text over a run of `=`
  after such a line is now out of place, like `# Second title`, with the same detail and the line number of
  the text line. A four-space line right after paragraph text is still a continuation line, so a paragraph, an
  indented line and then a line over `=` stay one paragraph and are not read as a second H1. Blank lines and
  indented lines inside a list item belong to the item, so they are not read as code either. In a block
  quote, in an HTML block that ends at a blank line and right after a link reference definition, an
  indented line is not read as code up to the next blank line. An HTML block that starts with a comment,
  `<pre>`, `<script>`, `<style>`, `<textarea>`, `<?`, `<![CDATA[` or `<!` followed by a letter runs to its
  end marker instead, even past blank lines.

## 0.3.19 (2026-10-03)

Two repairs from an outside re-check of 2026-10-03, tracked as Tek-564, made in the hosted validator first and
mirrored here. The first one narrows which files pass the sections check. A file with a second H1 written as a
setext heading, which was `valid` before, is now `valid with warnings`, and under `--strict` it exits 1.

- A second H1 written as a line of text over a run of `=` is now out of place, like `# Second title`. It warns
  between the title and the first H2 and after the last section, with the same detail and the line number of the
  text line, and it ends the section before it. A heading over several lines and text that starts with `#`
  are still not H1 headings, and the underline is never a heading or content. The new reading skips a thematic
  break, the start of an HTML block and a link reference definition over a run of `=`.
- The release check in the README named the tag of the previous release. It now names the tag of the version
  you installed, and a new test requires every version the README names in a tag, commit or install form to
  be the version in `package.json`.

## 0.3.18 (2026-10-03)

One repair from an outside read of 2026-10-02, tracked as Tek-562, made in the hosted validator first and
mirrored here. It widens which files pass the sections check. A valid file that warned before no longer does,
and under `--strict` it no longer exits 1.

- An H2 written as `##` and a tab now counts as a section. So does a one-line setext H2, which is a
  line of text followed by a line of hyphens. Both are H2 headings in CommonMark, and the validator warned "no H2 sections found"
  on a file that held one. The text line must follow a blank line or the start of the file. A list item
  above `---`, a thematic break, a bare `##` and anything inside a code fence are still not H2 headings.
  The links under a setext H2 count as that section's file list.
- The README now describes the H2 rule as the code applies it, where before it said a tab after
  the two hashes was not read.
- SECURITY.md names an encrypted route for reports: erik@turva.dev with the OpenPGP key at
  https://turva.dev/pgp-key.asc.

## 0.3.17 (2026-10-02)

No change to what the validator checks or reports. Documentation only.

- The README and SECURITY.md have a new section on verifying a release. It shows how to install a version in an empty directory and run `npm audit signatures`. It then compares the repository, the workflow and the commit in the provenance attestation with the release tag. It also says that provenance records where a release was built and does not show that the code is safe.

## 0.3.16 (2026-10-02)

Nine repairs from an outside read of this package on 2026-10-02, tracked as Tek-560, made in the hosted validator
first and mirrored here. Several of them change which files pass, so a file that passed before can now
warn, and the other way round. Under `--strict` a warning exits 1.

- A link label can no longer span a blank line. `[G`, a blank line and `H](https://example.com/g)` counted
  as one link before. It is not a link now.
- A backslash escape in a link target is resolved before the URL test, so `https\://example.com/g` is an
  absolute URL. It was counted as relative before.
- CR-only and CRLF line endings are turned into LF before the file is read. A file written with bare CR was
  one line before, and the whole document was read as the title.
- A setext title, one line of text underlined with `=`, now counts as the H1, and the summary is looked for
  after the underline. The failure message names both forms. A title over several lines is still not read.
- A link on a line that continues a list item, such as the line after a bare `-`, counts as that item's
  link for the sections check. After a bare marker the next line counts only when it is indented to the
  item's content column, which is 2 for `-` and 3 for `1.`, and a blank line right after a bare marker ends
  the item. A line after a blank line counts only when it is indented to the content column, where the
  content starts, so `-   item` needs 4 columns. A code fence indented less than the content column ends
  the item. A fence indented to it keeps the item open, and the line after the fence then counts only when
  it is indented to the content column too.
- The no-html check needs a real tag. `a <b + c` is prose and no longer warns. A tag still warns when it has
  its closing `>`, and so do a closing tag and an HTML comment. An attribute name can be any run of characters
  other than white space, quotes, `<`, `>`, `/` and `=` that holds a Unicode letter, a Unicode digit or the
  character `_`, so `<div @click="x">` and `<div *ngIf="x">` warn. A tag
  still open at the end of the file, such as `<div class="x"`, has no closing `>` and does not warn.
- The `<template>` scan for the discovery checks skips comments and the contents of elements such as script,
  style, title and textarea, so a `</template>` written inside one no longer ends the template early.
  A link relation placed after such a template is found now.
- `maskLocation` runs in linear time on a target with many query keys. Output is unchanged. A target with 8,000 query keys
  took about 2.8 seconds before and takes under 0.1 second now.
- An empty blockquote is not a summary. That is a block of `>` lines in which no line has text after the
  `>`. A block with any line of text is the summary, so `>` followed by `> Real summary` passes.

The README links to SECURITY.md and CHANGELOG.md now use absolute GitHub URLs, because neither file is in
the package. SECURITY.md now promises an initial response within one business day. Tests: sixteen new cases.

## 0.3.15 (2026-10-02)

The no-html check now also reports self-closing tags written without a space (`<br/>`, `<hr/>`), closing
tags (`</div>`) and HTML comments (`<!-- note -->`). Before, only an opening tag followed by whitespace or
`>` was found, so those three forms passed as plain markdown. The check reads the whole file as text and does
not skip code spans or fenced code, as before. Autolinks such as `<https://example.com>` are still not
tags. The change lets some files that passed fail the check with a warning, and under `--strict` such a file
now exits 1. Both the hosted validator and this package use the same pattern. The README now states what the check detects
and that the 65,536-character head read limit counts UTF-16 code units after comments and the contents of
script, style, title and template elements have been set aside. Tests: two new cases.

## 0.3.14 (2026-09-29)

A fifth outside read found that the CLI printed the password of a target with no scheme and no slash.
`llms-txt-validate "user_name:secret@example.com" --json` exited 2 and returned the target unmasked,
because the masking returned early when the value held no slash. Now a colon ahead of the last `@` in such a
value is read as user information and masked, so the target is `***@example.com`. Such a value is still
shown as given when its `@` has no colon ahead of it, as in `path@2x.png`. The README now states this rule
and the parser's limits: an escaped quote or a line break in a link title, nested brackets in a link
label and `##` followed by a tab are not recognised, and a link in a four-space indented block is counted
as a link but not as a file list. The `--json` usage text and the README now say the hosted JSON shape is
the same for a completed validation only, and that the hosted site's rate limiter can answer HTTP 429 as
plain text before the validator runs. Parser behaviour is unchanged. Tests: two new cases.

## 0.3.13 (2026-09-29)

A README-only release, after a fourth outside read. The README said input errors with `--json` return
`{ "error", "target" }`, but an unknown option, a second domain and a missing domain return `error` only.
It now separates the two shapes. It also states that a link title in parentheses is not read and that an
unbracketed link target ends at its first closing parenthesis, and that the hosted JSON has the same shape
only for a completed validation. No code or test changed.

## 0.3.12 (2026-09-29)

A README-only release. The README said links are read the way CommonMark reads them, while 0.3.11's own
notes state that link reference definitions and labels spanning several lines and an image used as a
reference are not handled. The README now limits the statement to the forms it lists and names the two
that are not handled. No code or test changed.

## 0.3.11 (2026-09-29)

A third outside re-check, run against 0.3.10, found a secret leak in the CLI, three regressions
that 0.3.10's own reference-link and code-span changes introduced, one more reference-link gap and
a diagnostic that put user input inside its sentence. Its finding codes are VN1, VREG1, VREG2,
VREG3, VN3, VN2 and P3-01. Every logic change landed in the hosted validator first and is mirrored
here.

`maskLocation` returned a target that had no recognized scheme and no `//` unchanged. Passed to the
CLI with `--json`, a target such as `user:secret@example.com/?token=x` came back in full, with its
username and password, in the JSON `target` field. When such a string has an `@` before its first
`/`, everything up to the last `@` is now masked as user information. A string with no `/` at all,
such as `path@2x.png`, is still read as a path.

The validator accepted a link reference definition in three places where CommonMark does not: on
the continuation line of a paragraph, inside inline code, and with any trailing text taken as its
title. A definition now has to follow a blank line, a heading, a list item or another definition.
It must not sit inside inline code, and its title is either absent or written in double quotes,
single quotes or parentheses. Separately, the text the links check reads was built by dropping the
lines of fenced code blocks and joining what remained, so a link destination could run on across a
fence. Fenced lines are now blanked where they stand.

An inline code span could cross a block boundary unless that boundary was a literally empty line. A
backtick in one list item then paired with a backtick in the next, and the link between them was
read as code. A line holding only spaces or tabs, a new list item and a heading now end the search
for the closing backtick.

Mapping each link back to its source line restarted the line scan for every link, so in the outside
measurement the work grew about three times with each doubling of the link count, where linear work
would only double. The scan now moves forward once over the links, which are already in document
order. Measured locally at 1 000, 2 000, 4 000 and 8 000 links, the median run took about 2, 4, 7
and 13 ms.

A shortcut reference link, `[label]` on its own with a matching definition, is now resolved, with
the link text as its label. A definition line's own text is never read as a use of that label. The
collapsed form `[label][]` already worked and now has a regression test. The re-check also listed
definitions and labels that span several lines and an image used as a reference, and this release
does not handle those.

When `validateHost` is given an address with a path, the `input-path` check used to put that path
inside its sentence. Its path now travels in its own `value` field, cut to 120 characters, and the
sentence is fixed. The CLI's text output prints the value in front of the sentence, where the path
appeared before.

`test/round3.test.mjs` holds the 17 new cases. The suite now runs 120.

## 0.3.10 (2026-09-28)

An outside re-check of this package against its 0.3.9 release found six more gaps, all mirrored
from the hosted validator, and one place where the changelog claimed more than this repository
publishes. Its finding codes are R1, R2, V1, V2, V3 and N03.

`maskLocation` left the text after an opaque scheme, such as a bare "u:", untouched: the URL
parser accepts it without a host, so clearing the (nonexistent) username and password was a
silent no-op, and the CLI's JSON `target` field printed it back in full. Such a target now goes
through the same string-based mask an unparseable one already used.

A link whose text contains an image, `[Guide ![icon](x)](y)`, was not recognized as a link at
all: any nested `[` ended the scan, image or not. An image nested in link text is now skipped
whole, so the outer link is found; the image itself still does not count as a link of its own,
and a link nested in a link, which CommonMark does not allow, still ends the scan as before.

A link target was checked in its literal source spelling, so a character reference such as
`&#58;` or `&#37;` hid a malformed destination (`https://host&#58;99999/`, an invalid port once
decoded) from the URL check. A target is now decoded the same way an HTML attribute value is
before it is checked.

A markdown reference link, `[text][label]` or the collapsed `[text][]`, was not resolved at all:
both checks read the pair as plain brackets, whether or not a `[label]: target` definition existed
elsewhere in the document. It is now resolved the way CommonMark expects,
against a definition written anywhere in the same document, before or after its use, in both the
links check and the section-list check. Inline code that crosses a real line ending, such as a
backtick-fenced link split over two lines, used to be masked only on its own line, so the second
line's content escaped the mask; the code span scan now covers the whole document and a link
inside such a span is correctly read as code, not as a link, in both checks.

A document read through the direct `validateLlmsTxt` API failed its H1 check on a leading
byte-order mark, while the same bytes read over HTTP already had it removed by the fetch path's
own decoder. A leading BOM is now stripped the same way in both.

The blockquote summary check required a literal space after `>`, so `>Summary` and a tab after
`>` warned as a missing summary although both are valid CommonMark blockquotes. The check now
accepts `>` followed by a space, a tab, or nothing; four or more leading spaces before `>` still
read as indented code, not a blockquote, as before.

The 0.3.4 entry below said a differential fuzz run found 0 of 390 000 generated documents
reading differently from parse5. That count came from one run in this repository's own history;
the generator, its seeds and the run's log were never published here, so the figure is not
independently reproducible from what this repository carries, and the entry now says so.

Node 18 and 20 are dropped from `engines.node` and from the CI matrix; the supported minimum is
now Node 22, the same floor markdown-parity-check already carries.

## 0.3.9 (2026-09-27)

An outside audit of this package found one more format gap mirrored from the hosted validator,
two missing CLI conveniences, an overbroad security claim and an incomplete third-party
attribution. Its finding codes are F08, V-04, V-05, SC-09 and E01.

The blockquote summary check now applies the same at-most-three-space rule as the H1 check and
the sections check. A trim-first prefix test used to erase the difference, so a code block
indented by four spaces or a tab, placed right after the title, passed as the summary.

The CLI now takes `--version`/`-V`, printing the installed package's own version from its
package.json and exiting 0, without a network read. `--help` still wins when both are given.

A fetch or network error under `--json` now carries `target`, the address given on the command
line with any user name, password and query value masked. When the underlying error names an
errno-style code, such as EAI_AGAIN, the object also carries it as `code`, read from the error's
cause first and from the error itself second. `error` is unchanged. An input validation error
still carries no `code` field.

SECURITY.md's provenance claim is scoped to versions 0.1.3 and later. Versions 0.1.1 and 0.1.2
were published from a maintainer machine before npm trusted publishing was set up for this
package, and they carry no attestation. Check the version page on npmjs.com for a given version.

The generated character-entities reference table, `NAMED_REFERENCE_DATA`, now names its source
package, its version and URL and its copyright holder in its own comment. The full MIT license
text of character-entities 2.0.2, copyright 2015 Titus Wormer, is recorded in a new
THIRD-PARTY-NOTICES.md, which ships in the tarball.

5 new tests, 89 total.

## 0.3.8 (2026-09-27)

An outside audit of this package and of the hosted validator found checks that read the format more loosely than CommonMark does, and output that could carry more than it should. This release mirrors the hosted validator in worker.js.

The H1 check now reads the heading as CommonMark does. `#  Example` and a tab after the marker pass, and `# ###`, a heading whose text is only its closing sequence, fails.

Inline code, an escaped bracket or an image no longer turns its text into a link. Links in an ordered list, after a tab, with a title or with a target in angle brackets now count.

The sections check now warns about a heading between the title and the first H2, or a second H1, and names its line.

Every link target has to parse as an HTTP or HTTPS URL with a host. `https://%` and `https://example.com:99999/` passed as absolute links before.

The content type is compared as a whole media type. `application/x-text/plain` and `text/markdownish` passed before.

`localhost.localdomain` is refused, because many hosts files point it at the loopback address.

An input error no longer repeats an address that holds `@`, `?` or `#`. The discovery targets are masked like redirect targets, every check detail is cleared of control characters, and a head longer than 65,536 characters is reported as read in part.

The CLI refuses an unknown option and a second domain with exit code 2. A missing domain returns JSON under `--json`, and `--help` exits with code 0.

On 49 real llms.txt files no summary changed. The heading rule adds a warning to the sections check of four files that already carried another warning. 12 new tests, 83 total.

## 0.3.7 (2026-09-26)

An outside retest of the hosted validator found two gaps. This release mirrors both fixes.

A path in the supplied address was dropped without a word. `validateHost("https://www.mintlify.com/docs/llms.txt")`
read `https://www.mintlify.com/llms.txt`, as the README says, but the result did not show that the
typed file was not the one checked. Both reads stay pinned to `/llms.txt` and the home page, because a
fixed path is part of the guard that keeps the validator from being used as a fetch proxy. Now the
result opens with an `info` check, `input-path`, that names the unused path. Neither the query nor the
fragment is shown, and an `info` check moves no summary and no exit code. A new export,
`enteredPath`, returns the path.

One detail in the `summary` warning covered two cases. A file with no blockquote and a file whose
blockquote comes after an introductory paragraph both read "recommended by the format (> one-line
summary), not required". The format places the summary directly after the title, so the status stays
`warn` in both cases, and the second case now names the line where the blockquote starts. A blockquote
after the first H2 or inside a fence is not read as a late summary.

Both changes mirror the hosted validator in worker.js. 3 new tests, 71 total.

## 0.3.6 (2026-09-23)

Turva's own internal audit round 19 of the hosted validator found two gaps this package still had,
and the same round changed the host check in two places.

K7-2: an accepted same-host redirect showed its target as sent, not masked. The `http-status`
check's detail for a followed redirect read "HTTP 200, followed a redirect from X to Y", and Y could
carry a query value or a fragment untouched, while a refused redirect was already masked in the
previous release. Both X and Y now go through `maskLocation`.

V6-U1: text quoted from the fetched file, today the `h1-title` and `summary` checks, kept the
bidirectional control characters U+202A to U+202E and U+2066 to U+2069. A site's own H1 or
blockquote summary could use one of these, the right-to-left override being the common case, to make
a check's detail read in a different order than the line it quotes. `validateHost` now passes every
check's detail through the new export `stripBidi` before it returns.

P3: the host check refuses two more TLDs, `arpa` and `onion`. RFC 8375 reserves `home.arpa` for home
networks, `in-addr.arpa` and `ip6.arpa` name addresses and not sites, and an onion name does not
resolve on the public web.

K7-P5: a host given with one trailing dot, such as `example.com.`, is the same host in its absolute
form. It was refused as not a public name and is now read as `example.com`. Only one dot is removed,
and a redirect target that ends in a dot is still refused.

All four changes mirror the hosted validator in worker.js. 8 new tests, 68 total.

## 0.3.5 (2026-09-22)

An outside review of the public repos found that a refused redirect could repeat credentials from
its target. A site can answer the llms.txt request with a redirect to an address such as
`https://user:password@host/llms.txt`. The fetch refused that redirect as it should, but the user
name and the password stayed in the returned `location` and in the detail of the first check, and a
shared report or a CI log would carry them from there.

A refused redirect target is now masked before it is cut to 120 characters, because a cut is not a
mask. The user name and the password are removed, the query values are masked as `***` and the
fragment is dropped. The same masking covers all four refusals: the unsafe target above, a target on
another host, a target the URL parser cannot read and the last hop of a chain that stops because it
has more than four redirects. When the parser cannot read a target, nothing tells which `@` ends the
user information, so everything up to the last `@` before the query is shown as `***`, and so is the
whole query. The new export `maskLocation` does the masking. Redirects are still refused and never
followed.

## 0.3.4 (2026-09-12)

A second outside review of the public repos found that the two v2 discovery checks read some pages
differently from an HTML parser. A differential fuzz against parse5, run while fixing those cases,
found more of the same kind, and an independent verifier of the fix found two more faults in the
same scan. This release fixes all of them.

Attribute values are now decoded the way the HTML tokenizer decodes them. `rel="described&#98;y"`
used to read as no relation, and `href="/llms.txt?a=1&amp;b=2"` was reported with `&amp;` still in
it. Named references come from the full WHATWG list and follow the attribute rule for a name
without its semicolon, and numeric references follow the replacement rules. The Link response
header is not HTML, so it is read as before.

Lowercasing and whitespace follow the tokenizer's ASCII rules. JavaScript's `toLowerCase` turns
U+0130 into two code units, which moved every index after it, so a relation after
`<title>İ</title>` was lost. A no-break space between head elements counted as whitespace, but a
parser starts the body there, so a link after it was reported even though the head does not carry
it. A carriage return inside a value is now read as a line feed, because a parser turns CRLF and CR
into LF before it tokenizes anything.

A tag now ends where the tokenizer ends it. An `=` where an attribute name is expected starts a
name, and so does a second `=` right after a quoted value, so a quote after it no longer hides a
`>`. A bogus comment or a doctype ends at its first `>`, and an end tag such as `</bodyx>` is no
longer read as `</body>`.

The search for the end of a comment was quadratic on a page that never uses the `--!>` ending,
which is almost every page. 100 KB of short comments took 770 ms, and the search is now one linear
pass.

After the fix, a differential run against parse5 across roughly 390 000 generated documents found
no more disagreements in that round, and the generators were written by two people, one of them
reviewing the fix separately. That run's generator, seeds and log were not published with this
repository, so the count is a record of what was done, not a figure this repository lets anyone
reproduce (2026-09-28: an outside re-check found the earlier wording overstated that; see 0.3.10).
The two checks still report only pass or info, and the summary line and the `--strict` exit code
are unchanged. Nothing else changed.

## 0.3.3 (2026-09-09)

An outside code review of the four repos found that the two llms.txt v2 discovery checks could
be told a link relation the page does not publish, and this release carries the fix.

`findLinkRelations` used to read `rel`, `type` and `href` with three independent regular
expressions over the whole tag, and the Link response header the same way. Neither knew where a
quoted value starts and ends, so `<link data-note=" rel='alternate' type='text/markdown'
href='/fake.md'">` reported a markdown alternate, and so did a Link header whose `title`
parameter happened to contain `rel=alternate; type=text/markdown`. Both now read null. HTML
attributes come from one forward scan that tracks quotes and keeps the first declaration of a
name, the way the HTML tokenizer does, and the Link header is parsed per RFC 8288 with quoted
strings, quoted pairs and commas inside a quoted value handled where they occur.

The two checks stay pass and info, the summary line and the `--strict` exit code are unchanged,
and a real relation reads exactly as before, quoted, single quoted or bare. What changed is that
a page can no longer claim one it does not serve.

The CI matrix now also runs Windows and Node 24, and the publish workflow refuses to run when
the version tag and package.json name different versions.

## 0.3.2 (2026-09-03)

A hostile reading of the package and of the hosted validator, round 16 of turva.dev's own
audits, found four things and this release carries them.

`--json` now answers every failure as JSON on stdout, `{"error": "..."}` with exit code 2, the
way the hosted validator answers `Accept: application/json`. Before this, a rejected host or a
failed first fetch printed plain text to stderr and nothing to stdout, so a CI step that parsed
the output as JSON got an empty document on exactly the run it needed to read.

A detail that is cut to 80 or 120 characters is now cut on a code point boundary. `slice`
counts UTF-16 code units, and a cut that landed inside a surrogate pair left a lone high
surrogate that serialises as bytes that are not valid UTF-8. The hosted validator had the same
cut on the requester's own input and served invalid UTF-8 under a `charset=utf-8` header,
measured on 3 September; both copies now share one `cut()` helper.

The two GitHub Actions workflows pin `actions/checkout` and `actions/setup-node` to commit
SHAs instead of the moving `v7` tags, so a moved tag upstream cannot run foreign code with the
publish job's `id-token: write` permission.

The README's first paragraph said the two v2 discovery checks are reported as information. They
read `pass` when the relation is there and `info` when it is not, and neither moves the summary;
the sentence now says that. The 0.1.1 entry below carries a dated correction about 0.1.0.

## 0.3.1 (2026-08-29)

A code scanning alert said the new section check runs in quadratic time on input the audited
site chooses, and it was right. The check tested every line with a regular expression that
rescanned the link target to the end of the line for each candidate on that line. A 300 kB
llms.txt built from a list marker and `[a](` repeated took 8 563 ms to read before and takes
17 ms now.

The link check had the same shape with a bound in place of a fix. Its pattern stopped a target
at 2 048 characters, which kept the pattern fast but dropped a longer target from the count, so
a file whose only link carries a very long URL was told it has no links at all. Both checks now
scan by index: every character is read once, there is no bound and no backtracking.

One behaviour changed with it. A link whose target is longer than 2 048 characters now counts
as a link. Fuzzing put both scans against the old patterns on 200 000 inputs each, and that is
the only difference either one produces.

## 0.3.0 (2026-08-29)

Six inputs that break the format used to pass. They fail or warn now, and the hosted
validator at turva.dev carries the same change, because it is the canonical copy and this
package mirrors it.

An indented line was read as a heading. The first non-empty line was trimmed before the H1
test, so `    # Site` passed as the title even though four spaces of indent make it a code
block. The line is now tested as markdown, with the three spaces CommonMark allows.

A section without a file list counted as a section. The check matched `## ` and the link
check scanned the whole file, so an H2 followed by a paragraph with a link in it satisfied
both. A section now counts when it carries a markdown list with a link in it, and the detail
line says how many of the sections do.

An entry with an empty name and a target with no host counted as a link. `[](https://x/y)`
gives an agent nothing to show and `https://` is a scheme without a host. Both warn now.

The v2 discovery checks claimed relations the page does not publish. The attribute readers
used `\b`, which matches inside `data-rel`, `data-type` and `data-href`, so a page could
pass on attributes a browser never reads. A relation without a target passed as a relation.
A media type only had to start with `text/markdown`, so `text/markdownish` passed. All three
are fixed, and a media type parameter such as `text/markdown;charset=utf-8` still passes.

Every one of the six carries a test with a positive control, and the six were run against
the old code first to prove they go red on it.

## 0.2.1 (2026-08-24)

The two v2 discovery checks now read the head a real HTML parser builds, and the code that
finds the link relations no longer uses regular expressions that a target site can make
quadratic.

Three code scanning alerts started this. One said the comment strip could leave a bare
`<!--` behind, and two said a character class that reads a tag's attributes runs in
quadratic time on input the target site chooses. All three were true. A page made of 256 KB
of unclosed `<script` tags took 2 383 ms to read before and takes 1 ms now.

The reader is one left to right scan by index. It removes comments and the content of the
script, style, title, noscript, noframes and template elements, and it stops where the head
ends: at the first text node or the first body level element, which is what the HTML parsing
spec describes in its "in head" and "after head" insertion modes. A `</head>` end tag does
not stop it, because a parser still puts link, meta, script, style, title and template into
the head element after one.

What this changes in a result: a link element that a parser moves into the body used to
count as a published relation and no longer does. Both checks stay information, never a
warning and never a failure, so the summary line and the `--strict` exit code are exactly
what they were in 0.2.0, and the eight structural checks on the llms.txt file did not move.

The behaviour was measured against parse5, a real HTML parser, on 200 000 generated
documents with four different seeds: identical on every input, in both directions. The
hosted validator at turva.dev/llms-txt-validator carries the same code and stays canonical.

## 0.2.0 (2026-08-24)

v2 of the llms.txt proposal was published on 2026-08-10. It left the file format
untouched and added discovery: a page names its markdown version with
`rel="alternate" type="text/markdown"` and the llms.txt that covers it with
`rel="describedby"`, either as HTML link elements or as a Link response header.

Two checks report those relations from the target site's home page. They report
`pass` when a relation is there and a new status, `info`, when it is not. Neither
is ever `warn` or `fail`, so the summary line and the `--strict` exit code are
exactly what they were in 0.1.8. The relations belong
to the site rather than to the file, and v2 is two weeks old, so scoring them as
warnings would have moved which files pass instead of measuring something new. How
common the relations are in the wild is not measured here and nothing claims it.

The fetch now reads two documents from the target, `/llms.txt` and `/`, each under
the same guards as before: https only, redirects only to the same host or its
www/apex twin, 8 second timeout, 256 KB cap. Nothing else is requested and the site
is still never crawled. `fetchLlmsTxt` takes `opts.path` and `opts.accept` for that
second read, and returns the response's Link header alongside the body.

The hosted validator at turva.dev/llms-txt-validator is canonical as always and
carries the same two checks.

## 0.1.8 (2026-08-04)

The 0.1.7 fix was incomplete. It bounded the label class and left the URL class
unbounded, and that class can still cross an opening bracket, so input shaped like
an unterminated link repeated over and over gave every position a fresh scan. 256 KB
of it took 6 410 ms after 0.1.7 and 6 182 ms before it, so that shape was never fixed.
CodeQL reopened the alert on the same line within the hour and it was right to.

The URL class is now bounded to 2 048 characters, which is longer than any link this
tool has any business reading, and the worst case drops to 172 ms. Behaviour is
identical to 0.1.6, measured across 200 000 fuzzed inputs on both the match count and
every captured URL.

## 0.1.7 (2026-08-04)

A ReDoS in the markdown link scan, reported by CodeQL against this package and
present in the hosted validator in the same words. The label class could cross an
opening bracket, so a run of unmatched `[` characters made the engine restart from
every position. 256 KB of them, which is this tool's own read cap, took 17,2 seconds
of CPU in one regex; after the fix the same input takes 0,5 ms. The input is fully
attacker controlled, because the validator fetches whatever URL it is given.

The label class now excludes the opening bracket as well, which makes the scan linear.
Behaviour is unchanged and that was measured rather than reasoned: across 200 000
fuzzed inputs the match count and every captured URL are identical, and the only
capture group that differs is the one this file never reads.

The CI workflow also declares `permissions: contents: read`, which it did not before.

Fixed in the hosted validator first, as the parity rule requires.

## 0.1.6 (2026-08-01)

Two corrections found by an audit of the hosted validator, mirrored here because
the hosted version is canonical.

The redirect chain now has one timeout budget instead of one per hop. `timeoutMs`
meant 8 seconds per redirect, so a file behind the maximum five hops could take
five times the value the caller passed. The budget is now taken once before the
loop and each hop gets what is left of it.

The check list said "Starts with a single H1 title". The check has never counted
H1 headings; it tests that the first non-empty line is one. The wording now says
what the code does. No behaviour change in that check.

## 0.1.5 (2026-07-26)

Documentation only. The README now states what the host check covers and
what it does not: IP literals, bracketed IPv6, ports, credentials and the
internal-use TLDs are refused before any request goes out, and every
redirect hop is checked by the same rule, but names are not resolved here,
so a public name pointing at a private address is stopped by the network
the fetch runs on rather than by this code. The repository also gained a
SECURITY.md covering the supported version, the trusted-publishing supply
chain and where to report a vulnerability. It stays out of the npm
tarball, which carries src, bin, README.md and LICENSE. No check logic
changes: src/index.mjs is identical to 0.1.4.

Correction 2026-08-16: the entry above overstates what the README says. The
README's host paragraph names IP literals, bracketed IPv6, localhost and the
internal-use TLDs; it does not name ports or credentials, although the code
refuses both (src/index.mjs rejects any port other than 443 or 80, rejects a
username or password, and re-checks every redirect hop by the same rule). The
published 0.1.5 tarball's README reads the same as the one on disk, so this
was wrong on the day it was written rather than gone stale. The README
paragraph is deliberately not being widened to match: it describes the check
as a host-shape check, which is what the code is, and claiming more there is
the direction this project avoids.

## 0.1.4 (2026-07-24)

VERSION is now read from package.json at module load, so the exported
VERSION and the HTTP User-Agent can no longer drift from the published
version (0.1.1 and 0.1.3 both shipped with a stale hardcoded string).
README and the package description now say eight checks, matching the
hosted validator page. The no-html check moved from a footnote into the
checks table as row 8. Bugs URL moved to GitHub issues (the repository
has been GitHub-canonical since 2026-07-21), and the README no longer
names a Codeberg mirror (the mirrors were removed 2026-07-24 after
Codeberg's Terms of Use change). No check logic changes.

## 0.1.3 (2026-07-21)

First release published from GitHub Actions with OIDC trusted publishing,
so npm carries a provenance attestation of where and how the package was
built. The repository URL moved to GitHub, which had become the canonical
host for the source. No check logic changes: src/index.mjs is identical
to 0.1.2, and only the version field, the repository URL and one README
sentence differ. The exported VERSION string still read 0.1.2 here, which
is the drift 0.1.4 removed.

## 0.1.2 (2026-07-21)

Check 1 now follows a redirect when the target is the same host or its
www/apex twin. Before this, a site that keeps llms.txt at the apex and
redirects www to it failed the first check even though the file was
there. The original rule refused every redirect, and that was an SSRF
control as much as a reading of the spec, so the follow is fenced in:
https only, no port, no credentials in the URL, a public hostname, at
most four hops, and the twin test on every hop. An off-site target, an
unsafe target, a missing Location header and a malformed one all still
fail the check. Four unit tests cover the new paths with a stubbed
fetch. The hosted validator at turva.dev/llms-txt-validator got the same
change the same day and stays canonical. The exported VERSION string,
which had read 0.1.0 since the first release, was corrected here.

## 0.1.1 (2026-07-18)

Restores the llms-txt-validate CLI command. npm rejected the ./-prefixed bin
path at publish time and stripped the bin mapping from 0.1.0, so 0.1.0
installs without the command. No code changes.

Corrected 2026-09-03: the 0.1.0 publish never completed, so there is no 0.1.0 on
the registry and nothing installs it; 0.1.1 is the first published version. The
two sentences above describe what npm did to the attempted 0.1.0 tarball, not
a version anyone can install.

## 0.1.0 (2026-07-18)

Never published: see the correction under 0.1.1. First release as written at the time. The seven structural checks of the hosted validator at
turva.dev/llms-txt-validator, extracted as an ES module with a CLI
(llms-txt-validate), a node:test suite, and the same JSON result shape as the
hosted endpoint.

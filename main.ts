// mend: one patch tool for every AI edit format. See SPEC.md (kit/starter/SPEC.md).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runTrial } from "./runner.ts";

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

const FORMATS = ["unified", "search-replace", "v4a", "json", "auto"] as const;
type FormatName = (typeof FORMATS)[number];

interface Options {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options | null {
  let format: FormatName = "auto";
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let count = 0;
  let end = false;
  for (const arg of argv) {
    if (!end && arg === "--") {
      end = true;
      continue;
    }
    if (!end && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check") {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === "--strict") {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith("--format=")) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = arg.slice("--format=".length);
        if (!(FORMATS as readonly string[]).includes(v)) return null;
        format = v as FormatName;
      } else {
        return null;
      }
    } else {
      count += 1;
      if (count > 1) return null;
      patch = arg;
    }
  }
  return { format, check, strict, patch };
}

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function splitPatchLines(text: string): string[] {
  const parts = text.split("\n");
  const lines = parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function isBlank(s: string): boolean {
  return s.trim() === "";
}

interface FileData {
  eol: "\r\n" | "\n";
  endsWithBreak: boolean;
  lines: string[];
}

function parseFile(text: string): FileData {
  if (text === "") return { eol: "\n", endsWithBreak: false, lines: [] };
  const firstLf = text.indexOf("\n");
  const eol: "\r\n" | "\n" = firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
  const endsWithBreak = text.endsWith(eol);
  const lines = text.split(eol);
  if (endsWithBreak) lines.pop();
  return { eol, endsWithBreak, lines };
}

function renderFile(f: FileData): string {
  if (f.lines.length === 0) return "";
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : "");
}

function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** The tree of files: contents on disk before the patch, and as edits leave them. */
class Tree {
  private before = new Map<string, string | null>();
  private after = new Map<string, string | null>();

  read(path: string): string | null {
    if (this.after.has(path)) return this.after.get(path) ?? null;
    let content: string | null = null;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      content = null;
    }
    this.before.set(path, content);
    this.after.set(path, content);
    return content;
  }

  write(path: string, content: string | null): void {
    if (!this.before.has(path)) this.read(path);
    this.after.set(path, content);
  }

  /** Whether the path exists in the tree as edits leave it (a directory on disk counts). */
  exists(path: string): boolean {
    if (this.after.has(path)) return this.after.get(path) !== null;
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.after);
  }

  restore(snap: Map<string, string | null>): void {
    this.after = new Map(snap);
  }

  /** Paths whose bytes changed, with their before/after contents. */
  changed(): { path: string; before: string | null; after: string | null }[] {
    const out: { path: string; before: string | null; after: string | null }[] = [];
    for (const [path, b] of this.before) {
      const a = this.after.has(path) ? this.after.get(path) ?? null : null;
      if (b !== a) out.push({ path, before: b, after: a });
    }
    return out;
  }

  writeToDisk(): void {
    const changed = this.changed();
    for (const c of changed) {
      if (c.after === null) rmSync(c.path, { force: true });
    }
    for (const c of changed) {
      if (c.after !== null) {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after, "utf8");
      }
    }
  }
}

function lineEqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, "");
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  return trimBoth(a) === trimBoth(b);
}

function occurrencesAtTier(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqAtTier(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrencesAtTier(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

interface MLine {
  text: string;
  context: boolean;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

function reindent(line: string, f: string, p: string): string {
  if (line === "" || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

function applyReplacement(lines: string[], pos: number, o: MLine[], n: MLine[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((ol, idx) => {
    if (ol.context) oCtx.push(idx);
  });
  const fLead = tier === 2 && o.length > 0 ? leadingWs(lines[pos]) : "";
  const pLead = tier === 2 && o.length > 0 ? leadingWs(o[0].text) : "";
  const out: string[] = [];
  let ctx = 0;
  for (const nl of n) {
    if (nl.context) {
      out.push(lines[pos + oCtx[ctx]]);
      ctx += 1;
    } else if (tier === 2) {
      out.push(reindent(nl.text, fLead, pLead));
    } else {
      out.push(nl.text);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

interface EditFailure {
  code: string;
  path: string;
}

interface Edit {
  apply(t: Tree, strict: boolean): EditFailure | null;
  move?: { oldPath: string; newPath: string };
}

interface BodyLine {
  kind: " " | "-" | "+" | "\\";
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string;
  newPath: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

function headerPath(line: string): string {
  return line.slice(4).split("\t")[0].trim();
}

function stripPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const m = DIFF_GIT_RE.exec(line);
    if (m) {
      const sec: Section = { oldPath: m[1], newPath: m[2], isCreate: false, isDelete: false, hunks: [] };
      i += 1;
      i = parseUnifiedHeader(lines, i, sec, false);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith("diff --git ")) throw new ParseError(i + 1);
    if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) {
      const sec: Section = {
        oldPath: stripPrefix(headerPath(line)),
        newPath: stripPrefix(headerPath(lines[i + 1])),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      i += 2;
      i = parseUnifiedHeader(lines, i, sec, true);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (line.startsWith("@@")) throw new ParseError(i + 1);
    if (line.startsWith("--- ")) throw new ParseError(i + 2);
    i += 1;
  }
  return sections;
}

function parseUnifiedHeader(lines: string[], i: number, sec: Section, pairSeen: boolean): number {
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith("@@")) return i;
    if (line.startsWith("diff --git ")) return i;
    if (line.startsWith("--- ")) {
      if (!pairSeen) {
        if (i + 1 >= n || !lines[i + 1].startsWith("+++ ")) throw new ParseError(i + 2);
        sec.oldPath = stripPrefix(headerPath(line));
        sec.newPath = stripPrefix(headerPath(lines[i + 1]));
        pairSeen = true;
        i += 2;
        continue;
      }
      if (i + 1 < n && lines[i + 1].startsWith("+++ ")) return i;
      throw new ParseError(i + 2);
    }
    if (line.startsWith("rename from ")) {
      if (!pairSeen) sec.oldPath = line.slice("rename from ".length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith("rename to ")) {
      if (!pairSeen) sec.newPath = line.slice("rename to ".length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith("new file mode")) {
      sec.isCreate = true;
      i += 1;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      sec.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseUnifiedHunks(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new ParseError(i + 1);
      const hunk: Hunk = { a: parseInt(m[1], 10), body: [] };
      i += 1;
      while (i < n) {
        const l = lines[i];
        if (l.startsWith("diff --git ")) break;
        if (l.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) break;
        if (l === "" || l[0] === " " || l[0] === "-" || l[0] === "+" || l[0] === "\\") {
          if (l === "") hunk.body.push({ kind: " ", text: "", raw: "" });
          else hunk.body.push({ kind: l[0] as " " | "-" | "+" | "\\", text: l.slice(1), raw: l });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].raw === "") hunk.body.pop();
      sec.hunks.push(hunk);
      continue;
    }
    if (line.startsWith("diff --git ")) return i;
    if (line.startsWith("--- ") && i + 1 < n && lines[i + 1].startsWith("+++ ")) return i;
    if (line.startsWith("--- ")) throw new ParseError(i + 2);
    i += 1;
  }
  return i;
}

function hunkNoBreak(hunk: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < hunk.body.length; k++) {
    if (hunk.body[k].kind === " " || hunk.body[k].kind === "+") last = k;
  }
  if (last < 0) return false;
  return last + 1 < hunk.body.length && hunk.body[last + 1].kind === "\\";
}

type HunkResult = { ok: true; file: FileData; d: number } | { ok: false };

function applyHunk(f: FileData, hunk: Hunk, d: number, strict: boolean): HunkResult {
  const o: MLine[] = [];
  const n: MLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === " ") {
      o.push({ text: b.text, context: true });
      n.push({ text: b.text, context: true });
    } else if (b.kind === "-") o.push({ text: b.text, context: false });
    else if (b.kind === "+") n.push({ text: b.text, context: false });
  }
  const noBreak = hunkNoBreak(hunk);
  if (o.length === 0) {
    const insertPos = Math.min(hunk.a + d, f.lines.length);
    const newLines = [...f.lines.slice(0, insertPos), ...n.map((x) => x.text), ...f.lines.slice(insertPos)];
    const ends = insertPos === f.lines.length ? !noBreak : f.endsWithBreak;
    return { ok: true, file: { eol: f.eol, endsWithBreak: ends, lines: newLines }, d: d + n.length };
  }
  const found = findTier(f.lines, o.map((x) => x.text), strict);
  if (!found) return { ok: false };
  const target = hunk.a - 1 + d;
  let best = found.positions[0];
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const newLines = applyReplacement(f.lines, best, o, n, found.tier);
  const ends = best + o.length === f.lines.length ? !noBreak : f.endsWithBreak;
  return { ok: true, file: { eol: f.eol, endsWithBreak: ends, lines: newLines }, d: d + (n.length - o.length) };
}

function unifiedEdit(sec: Section): Edit {
  const edit: Edit = {
    apply(t: Tree, strict: boolean): EditFailure | null {
      const oldP = sec.oldPath === "/dev/null" ? null : sec.oldPath;
      const newP = sec.newPath === "/dev/null" ? null : sec.newPath;
      if (oldP !== null && !isSafePath(oldP)) return { code: "unsafe", path: oldP };
      if (newP !== null && !isSafePath(newP)) return { code: "unsafe", path: newP };
      if (sec.isCreate || oldP === null) {
        if (newP === null) return { code: "unsafe", path: sec.newPath };
        if (t.exists(newP)) return { code: "exists", path: newP };
        const plus: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === "+") plus.push(b.text);
        let noBreak = false;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const body = sec.hunks[hi].body;
          for (let k = body.length - 1; k >= 0; k--) {
            if (body[k].kind === "+") {
              noBreak = k + 1 < body.length && body[k + 1].kind === "\\";
              break outer;
            }
          }
        }
        t.write(newP, plus.length === 0 ? "" : plus.join("\n") + (noBreak ? "" : "\n"));
        return null;
      }
      if (sec.isDelete || newP === null) {
        if (t.read(oldP) === null) return { code: "missing", path: oldP };
        t.write(oldP, null);
        return null;
      }
      const isMove = oldP !== newP;
      if (t.read(oldP) === null) return { code: "missing", path: oldP };
      if (isMove && t.exists(newP)) return { code: "exists", path: newP };
      let f = parseFile(t.read(oldP) as string);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(f, h, d, strict);
        if (!r.ok) return { code: "no-match", path: oldP };
        f = r.file;
        d = r.d;
      }
      const rendered = renderFile(f);
      if (isMove) {
        t.write(newP, rendered);
        t.write(oldP, null);
        edit.move = { oldPath: oldP, newPath: newP };
      } else {
        t.write(oldP, rendered);
      }
      return null;
    },
  };
  return edit;
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLine: number;
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, "");
  let i = 0;
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (trimEnd(lines[i]) === "<<<<<<< SEARCH") {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === "" || t.startsWith("```")) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new ParseError(searchLine);
      let sep = -1;
      let end = -1;
      for (let j = i + 1; j < n; j++) {
        if (trimEnd(lines[j]) === "=======") {
          sep = j;
          break;
        }
        if (trimEnd(lines[j]) === ">>>>>>> REPLACE") break;
      }
      if (sep >= 0) {
        for (let j = sep + 1; j < n; j++) {
          if (trimEnd(lines[j]) === ">>>>>>> REPLACE") {
            end = j;
            break;
          }
        }
      }
      if (sep < 0 || end < 0) throw new ParseError(searchLine);
      blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end), searchLine });
      prevPath = path;
      prevEnd = end + 1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return blocks;
}

function srEdit(b: SrBlock): Edit {
  return {
    apply(t: Tree, strict: boolean): EditFailure | null {
      if (!isSafePath(b.path)) return { code: "unsafe", path: b.path };
      if (b.oldLines.length === 0) {
        if (t.exists(b.path)) return { code: "exists", path: b.path };
        t.write(b.path, b.newLines.length === 0 ? "" : b.newLines.join("\n") + "\n");
        return null;
      }
      const content = t.read(b.path);
      if (content === null) return { code: "missing", path: b.path };
      const f = parseFile(content);
      const found = findTier(f.lines, b.oldLines, strict);
      if (!found) return { code: "no-match", path: b.path };
      if (found.positions.length > 1) return { code: "ambiguous", path: b.path };
      const pos = found.positions[0];
      const o: MLine[] = b.oldLines.map((x) => ({ text: x, context: false }));
      const nn: MLine[] = b.newLines.map((x) => ({ text: x, context: false }));
      const newLines = applyReplacement(f.lines, pos, o, nn, found.tier);
      t.write(b.path, renderFile({ eol: f.eol, endsWithBreak: f.endsWithBreak, lines: newLines }));
      return null;
    },
  };
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: MLine[];
  n: MLine[];
}

interface V4aSection {
  kind: "add" | "delete" | "update";
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

function chunkFromBody(anchor: string | null, eof: boolean, body: BodyLine[]): V4aChunk {
  const o: MLine[] = [];
  const n: MLine[] = [];
  for (const b of body) {
    if (b.kind === " ") {
      o.push({ text: b.text, context: true });
      n.push({ text: b.text, context: true });
    } else if (b.kind === "-") o.push({ text: b.text, context: false });
    else if (b.kind === "+") n.push({ text: b.text, context: false });
  }
  return { anchor, eof, o, n };
}

function parseV4a(lines: string[]): V4aSection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseError(1);
  if (lines[first].trim() !== "*** Begin Patch") throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== "*** End Patch") throw new ParseError(lines.length + 1);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: "add" | "delete" | "update";
    let path: string;
    if (line.startsWith("*** Add File: ")) {
      kind = "add";
      path = line.slice("*** Add File: ".length).trim();
    } else if (line.startsWith("*** Delete File: ")) {
      kind = "delete";
      path = line.slice("*** Delete File: ".length).trim();
    } else if (line.startsWith("*** Update File: ")) {
      kind = "update";
      path = line.slice("*** Update File: ".length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const headerLine = i + 1;
    i += 1;
    const start = i;
    while (i < last) {
      const l = lines[i];
      if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ")) break;
      i += 1;
    }
    const raw = lines.slice(start, i);
    while (raw.length > 0 && isBlank(raw[raw.length - 1])) raw.pop();
    sections.push(parseV4aSection(kind, path, raw, start, headerLine));
  }
  return sections;
}

function parseV4aSection(
  kind: "add" | "delete" | "update",
  path: string,
  raw: string[],
  start: number,
  headerLine: number,
): V4aSection {
  if (kind === "add") {
    const addLines: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      const l = raw[k];
      if (l === "") addLines.push("");
      else if (l.startsWith("+")) addLines.push(l.slice(1));
      else throw new ParseError(start + k + 1);
    }
    return { kind, path, moveTo: null, addLines, chunks: [], headerLine };
  }
  if (kind === "delete") {
    if (raw.length > 0) throw new ParseError(start + 1);
    return { kind, path, moveTo: null, addLines: [], chunks: [], headerLine };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx].startsWith("*** Move to: ")) {
    moveTo = raw[idx].slice("*** Move to: ".length).trim();
    idx += 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
  const flush = (): void => {
    if (cur) {
      chunks.push(chunkFromBody(cur.anchor, cur.eof, cur.body));
      cur = null;
    }
  };
  while (idx < raw.length) {
    const l = raw[idx];
    if (l.startsWith("@@")) {
      flush();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === "" ? null : anchorText, eof: false, body: [] };
      idx += 1;
      continue;
    }
    if (l === "*** End of File") {
      if (cur === null) throw new ParseError(start + idx + 1);
      cur.eof = true;
      flush();
      idx += 1;
      continue;
    }
    if (l === "" || l[0] === " " || l[0] === "-" || l[0] === "+") {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseError(start + idx + 1);
        cur = { anchor: null, eof: false, body: [] };
      }
      if (l === "") cur.body.push({ kind: " ", text: "", raw: "" });
      else cur.body.push({ kind: l[0] as " " | "-" | "+", text: l.slice(1), raw: l });
      idx += 1;
      continue;
    }
    throw new ParseError(start + idx + 1);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new ParseError(headerLine);
  return { kind, path, moveTo, addLines: [], chunks, headerLine };
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEqAtTier(lines[i], anchor, t)) return i;
    }
  }
  return null;
}

function applyV4aChunk(
  f: FileData,
  c: V4aChunk,
  cursor: number,
  strict: boolean,
): { ok: true; file: FileData; cursor: number } | { ok: false } {
  const lines = f.lines;
  if (c.o.length === 0) {
    const insertPos = c.eof ? lines.length : cursor;
    const newLines = [...lines.slice(0, insertPos), ...c.n.map((x) => x.text), ...lines.slice(insertPos)];
    return { ok: true, file: { eol: f.eol, endsWithBreak: f.endsWithBreak, lines: newLines }, cursor: insertPos + c.n.length };
  }
  const oTexts = c.o.map((x) => x.text);
  const found = findTier(lines, oTexts, strict, cursor);
  if (!found) return { ok: false };
  if (c.eof) {
    const eofPos = lines.length - oTexts.length;
    if (eofPos < cursor || !found.positions.includes(eofPos)) return { ok: false };
    const newLines = applyReplacement(lines, eofPos, c.o, c.n, found.tier);
    return { ok: true, file: { eol: f.eol, endsWithBreak: f.endsWithBreak, lines: newLines }, cursor: eofPos + c.n.length };
  }
  const pos = found.positions[0];
  const newLines = applyReplacement(lines, pos, c.o, c.n, found.tier);
  return { ok: true, file: { eol: f.eol, endsWithBreak: f.endsWithBreak, lines: newLines }, cursor: pos + c.n.length };
}

function v4aEdit(sec: V4aSection): Edit {
  const edit: Edit = {
    apply(t: Tree, strict: boolean): EditFailure | null {
      if (!isSafePath(sec.path)) return { code: "unsafe", path: sec.path };
      if (sec.kind === "add") {
        if (t.exists(sec.path)) return { code: "exists", path: sec.path };
        t.write(sec.path, sec.addLines.length === 0 ? "" : sec.addLines.join("\n") + "\n");
        return null;
      }
      if (sec.kind === "delete") {
        if (t.read(sec.path) === null) return { code: "missing", path: sec.path };
        t.write(sec.path, null);
        return null;
      }
      if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: "unsafe", path: sec.moveTo };
      const content = t.read(sec.path);
      if (content === null) return { code: "missing", path: sec.path };
      if (sec.moveTo !== null && t.exists(sec.moveTo)) return { code: "exists", path: sec.moveTo };
      let f = parseFile(content);
      let cursor = 0;
      for (const c of sec.chunks) {
        if (c.anchor !== null) {
          const a = findAnchor(f.lines, c.anchor, strict, cursor);
          if (a === null) return { code: "no-match", path: sec.path };
          cursor = a + 1;
        }
        const r = applyV4aChunk(f, c, cursor, strict);
        if (!r.ok) return { code: "no-match", path: sec.path };
        f = r.file;
        cursor = r.cursor;
      }
      const rendered = renderFile(f);
      if (sec.moveTo !== null) {
        t.write(sec.moveTo, rendered);
        t.write(sec.path, null);
        edit.move = { oldPath: sec.path, newPath: sec.moveTo };
      } else {
        t.write(sec.path, rendered);
      }
      return null;
    },
  };
  return edit;
}

interface JsonEditObj {
  path: string;
  command: "create" | "str_replace" | "insert";
  file_text?: unknown;
  old_str?: unknown;
  new_str?: unknown;
  insert_line?: unknown;
}

function validateJsonEdit(v: unknown, line: number): JsonEditObj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ParseError(line);
  const o = v as Record<string, unknown>;
  if (typeof o.path !== "string" || typeof o.command !== "string") throw new ParseError(line);
  if (o.command === "create") {
    if (typeof o.file_text !== "string") throw new ParseError(line);
    return { path: o.path, command: "create", file_text: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") throw new ParseError(line);
    if (o.new_str !== undefined && typeof o.new_str !== "string") throw new ParseError(line);
    return { path: o.path, command: "str_replace", old_str: o.old_str, new_str: o.new_str === undefined ? "" : o.new_str };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) throw new ParseError(line);
    if (typeof o.new_str !== "string") throw new ParseError(line);
    return { path: o.path, command: "insert", insert_line: o.insert_line, new_str: o.new_str };
  }
  throw new ParseError(line);
}

function parseJson(lines: string[]): JsonEditObj[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return [];
  const firstText = lines[first].trimStart();
  if (firstText.startsWith("[")) {
    const text = lines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseError(first + 1);
    return parsed.map((v) => validateJsonEdit(v, first + 1));
  }
  const edits: JsonEditObj[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateJsonEdit(parsed, i + 1));
  }
  return edits;
}

function splitJsonLines(s: string): string[] {
  const parts = s.split("\n");
  const lines = parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  if (s.endsWith("\n")) lines.pop();
  return lines;
}

function jsonEdit(e: JsonEditObj): Edit {
  return {
    apply(t: Tree, _strict: boolean): EditFailure | null {
      if (!isSafePath(e.path)) return { code: "unsafe", path: e.path };
      if (e.command === "create") {
        if (t.exists(e.path)) return { code: "exists", path: e.path };
        t.write(e.path, e.file_text as string);
        return null;
      }
      const content = t.read(e.path);
      if (content === null) return { code: "missing", path: e.path };
      if (e.command === "str_replace") {
        const oldStr = e.old_str as string;
        const newStr = e.new_str as string;
        const f = parseFile(content);
        if (f.eol === "\r\n") {
          const norm = (s: string): string => s.replace(/\r\n/g, "\n");
          const text = norm(content);
          const o = norm(oldStr);
          const nw = norm(newStr);
          let count = 0;
          let at = -1;
          for (let from = 0; ; ) {
            const idx = text.indexOf(o, from);
            if (idx < 0) break;
            count += 1;
            at = idx;
            from = idx + 1;
          }
          if (count === 0) return { code: "no-match", path: e.path };
          if (count > 1) return { code: "ambiguous", path: e.path };
          const replaced = text.slice(0, at) + nw + text.slice(at + o.length);
          t.write(e.path, replaced.replace(/\n/g, "\r\n"));
          return null;
        }
        let count = 0;
        let at = -1;
        for (let from = 0; ; ) {
          const idx = content.indexOf(oldStr, from);
          if (idx < 0) break;
          count += 1;
          at = idx;
          from = idx + 1;
        }
        if (count === 0) return { code: "no-match", path: e.path };
        if (count > 1) return { code: "ambiguous", path: e.path };
        t.write(e.path, content.slice(0, at) + newStr + content.slice(at + oldStr.length));
        return null;
      }
      const f = parseFile(content);
      const line = e.insert_line as number;
      if (line < 0 || line > f.lines.length) return { code: "no-match", path: e.path };
      const ins = splitJsonLines(e.new_str as string);
      const newLines = [...f.lines.slice(0, line), ...ins, ...f.lines.slice(line)];
      t.write(e.path, renderFile({ eol: f.eol, endsWithBreak: f.endsWithBreak, lines: newLines }));
      return null;
    },
  };
}

function detectFormat(lines: string[]): FormatName | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === "*** Begin Patch") return "v4a";
  const firstText = lines[first].trimStart();
  if (firstText.startsWith("[") || firstText.startsWith("{")) return "json";
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, "");
  for (const l of lines) {
    if (trimEnd(l) === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) return "unified";
  }
  return null;
}

function parsePatch(format: FormatName, lines: string[]): Edit[] {
  if (format === "unified") return parseUnified(lines).map(unifiedEdit);
  if (format === "search-replace") return parseSearchReplace(lines).map(srEdit);
  if (format === "v4a") return parseV4a(lines).map(v4aEdit);
  return parseJson(lines).map(jsonEdit);
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    out("error: usage");
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (opts.patch === null || opts.patch === "-") {
    patchText = readFileSync(0, "utf8");
  } else {
    try {
      patchText = readFileSync(opts.patch, "utf8");
    } catch {
      out("error: no-patch");
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);
  const format = opts.format === "auto" ? detectFormat(lines) : opts.format;
  if (format === null) {
    out("error: format");
    process.exitCode = 2;
    return;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(format, lines);
  } catch (e) {
    if (e instanceof ParseError) {
      out(`error: parse ${e.line}`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    out("error: parse 1");
    process.exitCode = 2;
    return;
  }
  const tree = new Tree();
  const failures: EditFailure[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const e of edits) {
    const snap = tree.snapshot();
    const f = e.apply(tree, opts.strict);
    if (f) {
      tree.restore(snap);
      failures.push(f);
    } else if (e.move) {
      moves.push(e.move);
    }
  }
  if (failures.length > 0) {
    for (const f of failures) out(`error: ${f.code} ${f.path}`);
    out(`failed: ${failures.length} of ${edits.length} edits`);
    process.exitCode = 1;
    return;
  }
  const changed = tree.changed();
  const added = new Set<string>();
  const deleted = new Set<string>();
  const modified = new Set<string>();
  for (const c of changed) {
    if (c.before === null) added.add(c.path);
    else if (c.after === null) deleted.add(c.path);
    else modified.add(c.path);
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of added) rows.push({ key: p, text: `A ${p}` });
  for (const p of deleted) rows.push({ key: p, text: `D ${p}` });
  for (const p of modified) rows.push({ key: p, text: `M ${p}` });
  for (const m of moves) {
    if (deleted.has(m.oldPath) && added.has(m.newPath)) {
      const di = rows.findIndex((r) => r.text === `D ${m.oldPath}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.text === `A ${m.newPath}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: m.newPath, text: `R ${m.oldPath} -> ${m.newPath}` });
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!opts.check) tree.writeToDisk();
  for (const r of rows) out(r.text);
  out(rows.length === 1 ? "ok: 1 file" : `ok: ${rows.length} files`);
}

// Entry point (kept last so every declaration above is initialized first).
if (process.env.MAKEFUN_ENV_URL) {
  try {
    await runTrial(process.env.MAKEFUN_ENV_URL);
  } catch {
    process.exitCode = 1;
  }
} else {
  main();
}

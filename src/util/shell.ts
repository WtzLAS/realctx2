/**
 * A small shell command-line parser (§6.8.3, §6.10.3). It is deliberately conservative: it
 * recognizes simple commands, quoting, redirects and the common separators, and reports
 * the file-system effects realctx2 cares about. Anything it cannot understand has no effects.
 */
import { basename, isAbsolute, join, normalize, resolve } from "node:path";

export interface ShellPart {
  words: string[];
  redirects: Array<{ op: string; target: string }>;
}

/** Split a command line into simple commands. */
export function parseShell(line: string): ShellPart[] {
  const parts: ShellPart[] = [];
  let cur: ShellPart = { words: [], redirects: [] };
  let word = "";
  let hasWord = false;
  let pendingRedirect: string | null = null;
  const heredocs: string[] = [];
  const pushWord = () => {
    if (!hasWord) return;
    if (pendingRedirect) {
      if (pendingRedirect.startsWith("<<")) heredocs.push(word);
      else cur.redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else cur.words.push(word);
    word = "";
    hasWord = false;
  };
  const endPart = () => {
    pushWord();
    pendingRedirect = null;
    if (cur.words.length || cur.redirects.length) parts.push(cur);
    cur = { words: [], redirects: [] };
  };
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;
    if (ch === "\\") {
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < n) {
        word += line[i + 1];
        hasWord = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end < 0 ? n : end);
      hasWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < n && '"\\$`\n'.includes(line[i + 1]!)) {
          word += line[i + 1];
          i += 2;
        } else word += line[i++];
      }
      hasWord = true;
      i++;
      continue;
    }
    if (ch === "$" && line[i + 1] === "(") {
      // command substitution: kept as part of the word, not analyzed
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (line[j] === "(") depth++;
        else if (line[j] === ")" && --depth === 0) break;
      }
      word += line.slice(i, Math.min(n, j + 1));
      hasWord = true;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const end = line.indexOf("`", i + 1);
      word += line.slice(i, end < 0 ? n : end + 1);
      hasWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (ch === "#" && !hasWord) {
      const end = line.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === "\n") {
      endPart();
      i++;
      if (heredocs.length) {
        // skip here-document bodies
        for (const delim of heredocs.splice(0)) {
          for (;;) {
            const eol = line.indexOf("\n", i);
            const row = line.slice(i, eol < 0 ? n : eol);
            i = eol < 0 ? n : eol + 1;
            if (row.trim() === delim || i >= n) break;
          }
        }
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushWord();
      i++;
      continue;
    }
    // redirects: [n]>, [n]>>, &>, >|, <, <<, <<-, <<<, n>&m
    const redir = /^(?:&>>?|\d*>>?\|?|\d*<<<|\d*<<-?|\d*<)(?:&\d+|&-)?/.exec(line.slice(i));
    if (redir && (redir[0].includes(">") || redir[0].includes("<")) && (!hasWord || /^\d+$/.test(word))) {
      if (hasWord && /^\d+$/.test(word)) {
        word = "";
        hasWord = false;
      } else pushWord();
      const op = redir[0];
      i += op.length;
      if (!/&\d+$|&-$/.test(op)) pendingRedirect = op.replace(/^\d+/, "");
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      endPart();
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      endPart();
      i++;
      continue;
    }
    if ((ch === "(" || ch === ")") && !hasWord) {
      endPart();
      i++;
      continue;
    }
    if ((ch === "{" || ch === "}") && !hasWord && (i + 1 >= n || /[\s;]/.test(line[i + 1]!))) {
      endPart();
      i++;
      continue;
    }
    word += ch;
    hasWord = true;
    i++;
  }
  endPart();
  return parts.filter((p) => p.words.length > 0 || p.redirects.length > 0);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["sudo", "command", "exec", "time", "nohup", "nice", "builtin"]);

/** Strip leading env assignments, `env`, and transparent wrappers. */
function stripPrefix(words: string[]): string[] {
  let w = [...words];
  for (;;) {
    while (w.length && ASSIGN.test(w[0]!)) w = w.slice(1);
    if (w[0] === "env") {
      w = w.slice(1);
      while (w.length && (ASSIGN.test(w[0]!) || /^-[iu]/.test(w[0]!))) w = w.slice(1);
      continue;
    }
    if (w.length && WRAPPERS.has(w[0]!)) {
      w = w.slice(1);
      while (w.length && w[0]!.startsWith("-")) w = w.slice(1);
      continue;
    }
    return w;
  }
}

/**
 * Normalized command lines for pattern matching (§6.10.3): one per part of a compound command,
 * whitespace collapsed, leading env assignments and `cd … &&` prefixes removed.
 */
export function normalizeCommandParts(line: string): string[] {
  const out: string[] = [];
  for (const part of parseShell(line)) {
    const w = stripPrefix(part.words);
    if (w.length === 0 || w[0] === "cd") continue;
    out.push(w.join(" ").replace(/\s+/g, " ").trim());
  }
  return out;
}

export interface CommandEffects {
  /** Normalized command lines, one per simple command. */
  parts: string[];
  moves: Array<{ from: string; to: string }>;
  deletes: string[];
  copies: Array<{ from: string; to: string }>;
  mkdirs: string[];
  /** Paths the command writes to or removes. */
  writes: string[];
  /** Every path-like argument, resolved. */
  touched: string[];
  /** Directories entered with cd. */
  cds: string[];
}

export interface AnalyzeOptions {
  cwd: string;
  isDir?: (absPath: string) => boolean;
  exists?: (absPath: string) => boolean;
}

function operands(args: string[], valueFlags: string[] = []): { ops: string[]; flags: string[] } {
  const ops: string[] = [];
  const flags: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.startsWith("-") && a.length > 1) {
      flags.push(a);
      if (valueFlags.includes(a)) i++;
      continue;
    }
    ops.push(a);
  }
  return { ops, flags };
}

function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const name of names) {
      if (a === name) return args[i + 1];
      if (name.startsWith("--") && a.startsWith(name + "=")) return a.slice(name.length + 1);
    }
  }
  return undefined;
}

const PATHISH = /^[\w.@+~/-]+$/;

/** Report the file-system effects of a command line. All paths are absolute. */
export function analyzeCommand(line: string, opts: AnalyzeOptions): CommandEffects {
  const fx: CommandEffects = { parts: [], moves: [], deletes: [], copies: [], mkdirs: [], writes: [], touched: [], cds: [] };
  let cwd = opts.cwd;
  const abs = (p: string) => normalize(isAbsolute(p) ? p : resolve(cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
  const isDir = (p: string) => p.endsWith("/") || (opts.isDir?.(abs(p)) ?? false);
  const touch = (p: string) => {
    if (!p || p.startsWith("-") || !PATHISH.test(p)) return;
    const a = abs(p);
    if (!fx.touched.includes(a)) fx.touched.push(a);
  };
  const write = (p: string) => {
    const a = abs(p);
    if (!fx.writes.includes(a)) fx.writes.push(a);
    touch(p);
  };
  const intoDir = (srcs: string[], dst: string, forceDir: boolean) =>
    srcs.map((s) => ({ from: abs(s), to: forceDir || srcs.length > 1 || isDir(dst) ? join(abs(dst), basename(abs(s))) : abs(dst) }));

  for (const part of parseShell(line)) {
    const w = stripPrefix(part.words);
    for (const r of part.redirects) {
      if (r.op.includes(">") && r.target !== "/dev/null" && !r.target.startsWith("&")) write(r.target);
      else if (r.op === "<") touch(r.target);
    }
    if (w.length === 0) continue;
    const cmd = basename(w[0]!);
    const args = w.slice(1);
    if (cmd === "cd" || cmd === "pushd") {
      const target = args.find((a) => !a.startsWith("-"));
      if (target && target !== "-") {
        cwd = abs(target);
        fx.cds.push(cwd);
      }
      continue;
    }
    fx.parts.push(w.join(" ").replace(/\s+/g, " ").trim());
    let sub = cmd;
    let rest = args;
    if (cmd === "git") {
      // skip global options: -C <dir>, -c k=v, --git-dir=…
      let i = 0;
      while (i < args.length && args[i]!.startsWith("-")) {
        if (args[i] === "-C" && args[i + 1]) cwd = abs(args[i + 1]!);
        i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
      }
      sub = `git ${args[i] ?? ""}`;
      rest = args.slice(i + 1);
    }
    switch (sub) {
      case "mv":
      case "git mv": {
        const t = flagValue(rest, ["-t", "--target-directory"]);
        const { ops } = operands(rest, ["-t", "--target-directory", "-S", "--suffix"]);
        if (t) fx.moves.push(...intoDir(ops, t, true));
        else if (ops.length >= 2) fx.moves.push(...intoDir(ops.slice(0, -1), ops[ops.length - 1]!, false));
        for (const m of fx.moves) {
          if (!fx.writes.includes(m.from)) fx.writes.push(m.from);
          if (!fx.writes.includes(m.to)) fx.writes.push(m.to);
        }
        ops.forEach(touch);
        break;
      }
      case "cp": {
        const t = flagValue(rest, ["-t", "--target-directory"]);
        const { ops } = operands(rest, ["-t", "--target-directory", "-S", "--suffix"]);
        const copies = t ? intoDir(ops, t, true) : ops.length >= 2 ? intoDir(ops.slice(0, -1), ops[ops.length - 1]!, false) : [];
        fx.copies.push(...copies);
        for (const c of copies) if (!fx.writes.includes(c.to)) fx.writes.push(c.to);
        ops.forEach(touch);
        break;
      }
      case "rm":
      case "rmdir":
      case "unlink": {
        const { ops } = operands(rest);
        for (const p of ops) {
          fx.deletes.push(abs(p));
          write(p);
        }
        break;
      }
      case "git rm": {
        const { ops, flags } = operands(rest);
        if (!flags.includes("--cached")) {
          for (const p of ops) {
            fx.deletes.push(abs(p));
            write(p);
          }
        } else ops.forEach(touch);
        break;
      }
      case "mkdir": {
        const { ops } = operands(rest, ["-m", "--mode"]);
        for (const p of ops) {
          fx.mkdirs.push(abs(p));
          touch(p);
        }
        break;
      }
      case "sed":
      case "gsed": {
        const inPlace = rest.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
        const hasScriptFlag = rest.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"));
        const { ops } = operands(rest, ["-e", "-f", "--expression", "--file"]);
        // BSD sed: `-i ''` leaves an empty operand
        const files = (hasScriptFlag ? ops : ops.slice(1)).filter((f) => f !== "");
        for (const f of files) (inPlace ? write : touch)(f);
        break;
      }
      case "perl": {
        const inPlace = rest.some((a) => /^-[a-zA-Z0-9]*i/.test(a));
        const { ops } = operands(rest, ["-e", "-E"]);
        for (const f of ops) (inPlace ? write : touch)(f);
        break;
      }
      case "tee": {
        const { ops } = operands(rest);
        ops.forEach(write);
        break;
      }
      case "touch":
      case "truncate": {
        const { ops } = operands(rest, ["-s", "--size", "-d", "-t", "-r"]);
        ops.forEach(write);
        break;
      }
      case "dd": {
        for (const a of rest) {
          if (a.startsWith("of=")) write(a.slice(3));
          else if (a.startsWith("if=")) touch(a.slice(3));
        }
        break;
      }
      case "git checkout":
      case "git restore": {
        const dd = rest.indexOf("--");
        let paths: string[];
        if (dd >= 0) paths = rest.slice(dd + 1);
        else {
          const { ops } = operands(rest, ["-b", "-B", "--source", "-s", "--orphan"]);
          // without `--`, `git checkout <x>` is a path only when it names an existing file
          paths = sub === "git restore" ? ops : ops.filter((p) => p === "." || (opts.exists?.(abs(p)) ?? false));
        }
        const stagedOnly = sub === "git restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
        for (const p of paths) (stagedOnly ? touch : write)(p);
        break;
      }
      default: {
        for (const a of rest) {
          if (a.startsWith("-")) {
            const eq = a.indexOf("=");
            if (eq > 0) touch(a.slice(eq + 1));
            continue;
          }
          if (a.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(a) || (opts.exists?.(abs(a)) ?? false)) touch(a);
        }
      }
    }
  }
  return fx;
}

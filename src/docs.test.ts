/**
 * Documentation versus code: these tests fail the build when README.md, CHANGELOG.md or a page under docs/ stops
 * agreeing with what the extension does (QLT-03). The commands and flags come from running the real extension
 * factory over the fake pi host, the settings rows from SETTINGS, and the example configuration from the real
 * settings reader, so none of them is a second copy of a list.
 *
 * Repository files are read relative to `import.meta.url`: the compiled file is .test-dist/docs.test.js, so the
 * repository root is one level up. Nothing here uses the network; the only writes are to temporary directories.
 *
 * README.md must keep working on the npm and pi.dev package pages, where a relative link does not resolve; the
 * links check below understands both relative and absolute GitHub URLs so that a later change can switch forms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtension } from "./index.js";
import { PI_FLAGS, SETTINGS, prepareSettings, readLayerFile } from "./settings.js";
import { makeFakePi } from "./testkit.js";

/** The text of a repository file, given its path from the repository root. */
function readRepo(relativePath: string): string {
  return readFileSync(new URL("../" + relativePath, import.meta.url), "utf8");
}

/** What the real extension registers over the fake host, with every settings source pointed at an empty temporary directory. */
async function registerAll(): Promise<{ commands: string[]; flags: string[] }> {
  const fake = makeFakePi();
  const dir = mkdtempSync(join(tmpdir(), "docs-check-"));
  // An empty env, so no variable of the developer's shell reaches the settings.
  const extension = createExtension({
    settings: { env: {}, globalConfigPath: join(dir, "config.json"), home: dir },
    discoverModelIds: async () => [],
  });
  await extension(fake.pi);
  return { commands: [...fake.commands.keys()], flags: fake.flags.map((flag) => flag.name) };
}

async function registeredCommands(): Promise<string[]> {
  return (await registerAll()).commands;
}

async function registeredFlags(): Promise<string[]> {
  return (await registerAll()).flags;
}

/** One line per documentation gap for a list of command names: no heading in the commands reference, no list line in the README. */
function commandProblems(names: readonly string[], commandsDoc: string, readme: string): string[] {
  const headings = new Set(commandsDoc.split("\n").map((line) => line.trim()));
  const readmeLines = readme.split("\n");
  const problems: string[] = [];
  for (const name of names) {
    if (!headings.has(`## /${name}`) && !headings.has(`## \`/${name}\``)) {
      problems.push(`${name}: no heading in docs/reference/commands.md`);
    }
    if (!readmeLines.some((line) => line.startsWith(`- \`/${name}\``))) {
      problems.push(`${name}: no list line in README.md`);
    }
  }
  return problems;
}

test("docs check: the extension registers the commands this suite expects to find documented", async () => {
  const names = await registeredCommands();
  for (const expected of ["mlx-init", "mlx-start", "mlx-stop"]) {
    assert.ok(names.includes(expected), `the extension did not register ${expected}; got [${names.join(", ")}]`);
  }
});

test("docs check: commandProblems reports a command with no heading in the commands reference and no line in the README", () => {
  const reference = "## /mlx-a\n\ntext\n";
  const readme = "- `/mlx-a`: x\n";
  assert.deepEqual(commandProblems(["mlx-a"], reference, readme), []);

  const two = commandProblems(["mlx-a", "mlx-b"], reference, readme);
  assert.equal(two.length, 2, two.join("\n"));
  assert.ok(two.every((line) => line.includes("mlx-b")), two.join("\n"));
  assert.ok(two.some((line) => line.includes("docs/reference/commands.md")), two.join("\n"));
  assert.ok(two.some((line) => line.includes("README.md")), two.join("\n"));

  // A heading written in backticks is still a heading.
  assert.deepEqual(commandProblems(["mlx-b"], "## `/mlx-b`\n", "- `/mlx-b`: y\n"), []);
  // A README mention that is not a list line does not count.
  const prose = commandProblems(["mlx-b"], "## /mlx-b\n", "see /mlx-b for details\n");
  assert.equal(prose.length, 1, prose.join("\n"));
  assert.ok(prose[0].includes("README.md"), prose[0]);
});

test("docs check: every registered command has a heading in docs/reference/commands.md and a line in README.md", async () => {
  const problems = commandProblems(await registeredCommands(), readRepo("docs/reference/commands.md"), readRepo("README.md"));
  assert.deepEqual(problems, []);
});

test("docs check: every pi flag the extension registers is the PI_FLAGS list and is named in docs/reference/configuration.md", async () => {
  const registered = [...(await registeredFlags())].sort();
  assert.deepEqual(registered, PI_FLAGS.map((flag) => flag.name).sort());
  const configuration = readRepo("docs/reference/configuration.md");
  for (const name of registered) {
    assert.ok(configuration.includes("`--" + name + "`"), `docs/reference/configuration.md does not name \`--${name}\``);
  }
});

/** The fields of a SETTINGS row that the configuration reference has to show. */
interface SettingRow {
  path: string;
  env?: string;
  cli?: string;
  initCli?: string;
  piFlag?: string;
}

/** The text from the line equal to `heading` up to the line before the next heading, or the end; throws when the heading is absent. */
function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start === -1) throw new Error(`no heading ${heading}`);
  let fenced = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    else if (!fenced && lines[i].startsWith("#")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** `token` as it is written in running text: between backticks. */
const ticked = (token: string): string => "`" + token + "`";

/** A table row whose first cell is a dotted setting key in backticks. */
const SETTINGS_ROW = /^\| `([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)` \|/;

/** One line per gap between the Settings table of the configuration reference and the SETTINGS rows. */
function settingsProblems(rows: readonly SettingRow[], doc: string): string[] {
  let section: string;
  try {
    section = sectionOf(doc, "## Settings");
  } catch {
    return ['docs/reference/configuration.md has no "## Settings" section'];
  }
  const tableRows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const match = SETTINGS_ROW.exec(line);
    if (match !== null) tableRows.set(match[1], line);
  }
  const problems: string[] = [];
  const known = new Set<string>();
  for (const row of rows) {
    known.add(row.path);
    const line = tableRows.get(row.path);
    if (line === undefined) {
      problems.push(`${row.path}: no row in the Settings table of docs/reference/configuration.md`);
      continue;
    }
    // Backticked text, compared whole, so `--port` is not satisfied by `--mlx-port` or by a bare word.
    const inRow: Array<[string, string | undefined]> = [
      ["environment variable", row.env],
      ["/mlx-start flag", row.cli],
      ["pi flag", row.piFlag === undefined ? undefined : "--" + row.piFlag],
    ];
    for (const [what, token] of inRow) {
      if (token !== undefined && !line.includes(ticked(token))) problems.push(`${row.path}: the ${what} ${ticked(token)} is not in its row`);
    }
    if (row.initCli !== undefined && !doc.includes(ticked(row.initCli))) {
      problems.push(`${row.path}: the /mlx-init flag ${ticked(row.initCli)} is not named in docs/reference/configuration.md`);
    }
  }
  for (const path of tableRows.keys()) {
    if (!known.has(path)) problems.push(`${path}: the Settings table names a setting that does not exist`);
  }
  return problems;
}

/** The environment variable names a source text mentions, sorted and without duplicates. */
function envNamesIn(text: string): string[] {
  const names = text.match(/\b(?:PI_MLX_MODELS_[A-Z0-9_]+|HF_[A-Z0-9_]+|PI_CODING_AGENT_DIR)\b/g) ?? [];
  return [...new Set(names)].sort();
}

/** One line per environment variable name that the document does not name in backticks. */
function envProblems(names: readonly string[], doc: string): string[] {
  return names.filter((name) => !doc.includes(ticked(name))).map((name) => `${name}: not named in backticks in docs/reference/configuration.md`);
}

/** The bodies of the fenced json blocks of a markdown text, in order. */
function jsonBlocksOf(markdown: string): string[] {
  const blocks: string[] = [];
  let body: string[] | undefined;
  for (const line of markdown.split("\n")) {
    if (body === undefined) {
      if (line.trimEnd() === "```json") body = [];
    } else if (line.startsWith("```")) {
      blocks.push(body.join("\n"));
      body = undefined;
    } else body.push(line);
  }
  return blocks;
}

/** What the real settings reader says about a config file with this text: its errors and warnings, or why it could not be read. */
function configProblems(jsonText: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "docs-check-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, jsonText);
    const layer = readLayerFile(path);
    if (layer.state !== "ok") return [layer.state === "absent" ? "the config file is absent" : `the config file ${layer.reason}`];
    const result = prepareSettings({ global: layer, env: {} });
    return result.ok ? result.warnings : [...result.errors, ...result.warnings];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SETTINGS_DOC = [
  "## Settings",
  "",
  "| Setting | Flag | pi flag | Environment variable |",
  "|---|---|---|---|",
  "| `server.port` | `--port` | `--mlx-port` | `PI_MLX_MODELS_PORT` |",
  "",
].join("\n");
const PORT_ROW: SettingRow = { path: "server.port", env: "PI_MLX_MODELS_PORT", cli: "--port", piFlag: "mlx-port" };

test("docs check: settingsProblems reports a missing row, a missing variable, flag or pi flag, a missing init flag and a row that is not a setting", () => {
  assert.deepEqual(settingsProblems([PORT_ROW], SETTINGS_DOC), []);

  const one = (problems: string[], ...needles: string[]) => {
    assert.equal(problems.length, 1, problems.join("\n"));
    for (const needle of needles) assert.ok(problems[0].includes(needle), `${JSON.stringify(problems[0])} does not include ${needle}`);
  };
  one(settingsProblems([PORT_ROW, { path: "server.host" }], SETTINGS_DOC), "server.host");
  one(settingsProblems([PORT_ROW], SETTINGS_DOC.replace("`PI_MLX_MODELS_PORT`", "")), "server.port", "PI_MLX_MODELS_PORT");
  one(settingsProblems([PORT_ROW], SETTINGS_DOC.replace("`--port`", "")), "server.port", "--port");
  one(settingsProblems([PORT_ROW], SETTINGS_DOC.replace("`--mlx-port`", "")), "server.port", "--mlx-port");
  // A bare substring is not enough: the flag must be in backticks, so `--mlx-port` does not stand in for `--port`.
  one(settingsProblems([PORT_ROW], SETTINGS_DOC.replace("`--port`", "--port")), "server.port", "--port");

  const init: SettingRow = { path: "mlxLm.version", initCli: "--mlx-lm-version" };
  const initDoc = SETTINGS_DOC + "| `mlxLm.version` | | | |\n";
  one(settingsProblems([PORT_ROW, init], initDoc), "mlxLm.version", "--mlx-lm-version");
  // The /mlx-init flags are listed in their own section; anywhere in the file counts.
  assert.deepEqual(settingsProblems([PORT_ROW, init], initDoc + "\n## `/mlx-init` arguments\n\n- `--mlx-lm-version` x\n"), []);

  one(settingsProblems([PORT_ROW], SETTINGS_DOC + "| `server.bogus` | | | |\n"), "server.bogus", "does not exist");
  one(settingsProblems([PORT_ROW], "## Other\n\ntext\n"), "## Settings");
});

test("docs check: the Settings table and SETTINGS list the same rows with each variable, flag and pi flag", () => {
  assert.deepEqual(settingsProblems(SETTINGS, readRepo("docs/reference/configuration.md")), []);
});

test("docs check: envNamesIn finds the environment variables a source text reads and envProblems reports an undocumented one", () => {
  const source = "const a = env.PI_MLX_MODELS_PORT; const t = env.HF_TOKEN; env.PI_CODING_AGENT_DIR; again PI_MLX_MODELS_PORT";
  assert.deepEqual(envNamesIn(source), ["HF_TOKEN", "PI_CODING_AGENT_DIR", "PI_MLX_MODELS_PORT"]);
  assert.deepEqual(envNamesIn("every PI_MLX_MODELS_* variable and the prefix PI_MLX_MODELS_ alone"), []);

  const problems = envProblems(["PI_MLX_MODELS_PORT", "PI_MLX_MODELS_NEW"], "Set `PI_MLX_MODELS_PORT` to change it.");
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.ok(problems[0].includes("PI_MLX_MODELS_NEW"), problems[0]);
});

test("docs check: every environment variable the non-test source reads is named in docs/reference/configuration.md", () => {
  const sourceDir = new URL("../src/", import.meta.url);
  const names = new Set<string>();
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file === "testkit.ts") continue;
    for (const name of envNamesIn(readFileSync(new URL(file, sourceDir), "utf8"))) names.add(name);
  }
  assert.ok(names.size > 0, "no environment variable name found in the source");
  assert.deepEqual(envProblems([...names].sort(), readRepo("docs/reference/configuration.md")), []);
});

test("docs check: configProblems rejects an unknown key and a warning", () => {
  assert.ok(configProblems('{"bogusKey":1}').length > 0, "an unknown top-level key was accepted");
  assert.ok(configProblems("this is not json").length > 0, "text that is not JSON was accepted");
  assert.deepEqual(configProblems('{"server":{"port":8090}}'), []);
});

test("docs check: the example config in the File layout section and each json block in README.md are accepted by the settings reader with no error and no warning", () => {
  const layout = jsonBlocksOf(sectionOf(readRepo("docs/reference/configuration.md"), "### File layout"));
  assert.ok(layout.length >= 1, "no json block in the File layout section");
  const readmeBlocks = jsonBlocksOf(readRepo("README.md"));
  assert.ok(readmeBlocks.length >= 1, "no json block in README.md");
  assert.deepEqual([layout[0], ...readmeBlocks].flatMap((block) => configProblems(block)), []);
});

/** The GitHub repository the absolute links of the documentation point at. */
interface RepoRef {
  owner: string;
  name: string;
}

/** A link target as a path from the repository root (empty when it leaves the repository) and its fragment (empty when none). */
interface RepoTarget {
  path: string;
  fragment: string;
}

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*(```|~~~)/;

/** The anchor GitHub gives a heading. */
function githubSlug(heading: string): string {
  return heading
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** The anchors a markdown text defines: one per heading outside code, repeats numbered -1, -2, and so on. */
function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
    if (match === null) continue;
    const slug = githubSlug(match[1].replace(/[ \t]+#+[ \t]*$/, "").trim());
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** The text without fenced blocks and inline code spans. */
function withoutCode(markdown: string): string {
  const kept: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) kept.push(line.replace(/`[^`\n]*`/g, ""));
  }
  return kept.join("\n");
}

/** Every link target in a markdown text, in order: links, images, HTML href and src, reference definitions; none from code. */
function linkTargetsOf(markdown: string): string[] {
  // `](` rather than a whole link, so the link around a badge image ([![alt](img)](url)) is found as well as the image.
  const pattern = /\]\([ \t]*(<[^>\n]*>|[^\s)]*)|\b(?:href|src)=(?:"([^"]*)"|'([^']*)')|^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;
  const targets: string[] = [];
  for (const match of withoutCode(markdown).matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    if (target !== "") targets.push(target);
  }
  return targets;
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Percent-decoding that leaves a malformed sequence as written. */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Where a link target points inside the repository, or null when it points elsewhere. */
function repoPathOf(target: string, fromFile: string, repo: RepoRef): RepoTarget | null {
  let local = target;
  if (URL_SCHEME.test(target)) {
    const own = `https://github.com/${repo.owner}/${repo.name}/`;
    const raw = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/`;
    if (target.startsWith(own + "blob/main/")) local = "/" + target.slice((own + "blob/main/").length);
    else if (target.startsWith(own + "tree/main/")) local = "/" + target.slice((own + "tree/main/").length);
    else if (target.startsWith(raw)) local = "/" + target.slice(raw.length);
    else return null;
  }
  const hash = local.indexOf("#");
  const pathPart = hash === -1 ? local : local.slice(0, hash);
  const fragment = hash === -1 ? "" : decoded(local.slice(hash + 1));
  if (pathPart === "") return { path: fromFile, fragment };
  const text = decoded(pathPart);
  const joined = text.startsWith("/") ? posix.normalize(text.slice(1)) : posix.normalize(posix.join(posix.dirname(fromFile), text));
  // A target that climbs out of the repository has no path; the caller reports it and never reads it.
  if (joined === ".." || joined.startsWith("../")) return { path: "", fragment };
  return { path: joined === "." ? "" : joined.replace(/\/$/, ""), fragment };
}

/** Owner and name of the GitHub repository, read from package.json. */
function repoFromPackage(): RepoRef {
  const url = (JSON.parse(readRepo("package.json")) as { repository?: { url?: string } }).repository?.url ?? "";
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  assert.ok(match !== null, `package.json repository.url is not a GitHub URL: ${url}`);
  return { owner: match[1], name: match[2] };
}

/** One line per link in the files (paths from rootDir) that does not resolve: no file, no anchor, or a path that leaves the repository. */
function linkProblems(rootDir: string, files: readonly string[], repo: RepoRef): string[] {
  const problems: string[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsIn = (path: string, absolute: string): Set<string> => {
    let anchors = anchorCache.get(path);
    if (anchors === undefined) {
      anchors = anchorsOf(readFileSync(absolute, "utf8"));
      anchorCache.set(path, anchors);
    }
    return anchors;
  };
  for (const file of files) {
    for (const target of linkTargetsOf(readFileSync(resolve(rootDir, file), "utf8"))) {
      const found = repoPathOf(target, file, repo);
      if (found === null) continue;
      const absolute = found.path === "" ? "" : resolve(rootDir, found.path);
      const inside = absolute !== "" && !relative(rootDir, absolute).startsWith("..");
      if (!inside) {
        problems.push(`${file}: ${target}: escapes the repository`);
        continue;
      }
      if (!existsSync(absolute)) {
        problems.push(`${file}: ${target}: no such file`);
        continue;
      }
      if (found.fragment !== "" && found.path.endsWith(".md") && statSync(absolute).isFile()) {
        if (!anchorsIn(found.path, absolute).has(found.fragment.toLowerCase())) problems.push(`${file}: ${target}: no such anchor`);
      }
    }
  }
  return problems;
}

/** The pages that no link reaches. */
function unlinkedPages(pages: readonly string[], linkedPaths: ReadonlySet<string>): string[] {
  return pages.filter((page) => !linkedPaths.has(page));
}

const REPO: RepoRef = { owner: "OWNER", name: "REPO" };

test("docs check: githubSlug follows GitHub's heading anchors", () => {
  assert.equal(githubSlug("`/mlx-init` arguments"), "mlx-init-arguments");
  assert.equal(githubSlug("/mlx-last"), "mlx-last");
  assert.equal(githubSlug("Sources, from highest precedence to lowest"), "sources-from-highest-precedence-to-lowest");
  assert.equal(githubSlug("File layout"), "file-layout");
  assert.equal(githubSlug("Pin or float the mlx-lm version"), "pin-or-float-the-mlx-lm-version");
  assert.equal(githubSlug("[Get started](x.md) now"), "get-started-now");
  assert.equal(githubSlug("snake_case-name"), "snake_case-name");
});

test("docs check: anchorsOf numbers repeated headings and ignores code", () => {
  assert.deepEqual([...anchorsOf("# A\n\n## A\n\n## A\n")].sort(), ["a", "a-1", "a-2"]);
  assert.deepEqual([...anchorsOf("# Real\n\n```sh\n# a comment, not a heading\n```\n\n~~~\n## Also code\n~~~\n")], ["real"]);
  assert.deepEqual([...anchorsOf("## Title ##\n")], ["title"]);
});

test("docs check: linkTargetsOf finds markdown links, images, HTML href and src and reference definitions, and skips code", () => {
  const text = [
    "[t](x.md#a) and ![i](a.png \"title\")",
    '<a href="b.html"><img alt="x" src="c.png" /></a>',
    "[![badge](d.svg)](e.md)",
    "[ref]: z.md",
    "",
    "```md",
    "[hidden](fenced.md) <a href=\"fenced.html\">",
    "```",
    "Inline `[hidden](inline.md)` code.",
  ].join("\n");
  assert.deepEqual(linkTargetsOf(text), ["x.md#a", "a.png", "b.html", "c.png", "d.svg", "e.md", "z.md"]);
});

test("docs check: repoPathOf maps a target to a repository path", () => {
  assert.deepEqual(repoPathOf("../a.md#b", "docs/x/y.md", REPO), { path: "docs/a.md", fragment: "b" });
  assert.deepEqual(repoPathOf("#only", "docs/x/y.md", REPO), { path: "docs/x/y.md", fragment: "only" });
  assert.deepEqual(repoPathOf("./docs/a.md", "README.md", REPO), { path: "docs/a.md", fragment: "" });
  assert.deepEqual(repoPathOf("https://github.com/OWNER/REPO/blob/main/docs/a.md#b", "README.md", REPO), { path: "docs/a.md", fragment: "b" });
  assert.deepEqual(repoPathOf("https://raw.githubusercontent.com/OWNER/REPO/main/assets/a.png", "README.md", REPO), { path: "assets/a.png", fragment: "" });
  assert.equal(repoPathOf("https://github.com/OTHER/REPO/blob/main/docs/a.md", "README.md", REPO), null);
  assert.equal(repoPathOf("https://example.com/x", "README.md", REPO), null);
  assert.equal(repoPathOf("mailto:a@b.c", "README.md", REPO), null);
  assert.equal(repoPathOf("../../../etc/passwd", "docs/a.md", REPO)?.path, "");
  assert.equal(repoPathOf("docs/my%20page.md", "README.md", REPO)?.path, "docs/my page.md");
});

test("docs check: linkProblems reports a missing file, a missing anchor and an escaping link", () => {
  const parent = mkdtempSync(join(tmpdir(), "docs-check-tree-"));
  try {
    const root = join(parent, "repo");
    mkdirSync(join(root, "docs"), { recursive: true });
    // Outside the tree, so a link that climbs out would resolve to a real file if it were followed.
    writeFileSync(join(parent, "outside.md"), "# Outside\n");
    writeFileSync(join(root, "docs", "ok.md"), "# Real heading\n");
    writeFileSync(
      join(root, "README.md"),
      [
        "# Intro",
        "[a](docs/ok.md)",
        "[b](docs/missing.md)",
        "[c](docs/ok.md#nope)",
        "[d](#nope-here)",
        "[e](../outside.md)",
        "[f](docs/ok.md#real-heading)",
        "[g](#intro)",
        "",
      ].join("\n"),
    );
    const problems = linkProblems(root, ["README.md"], REPO);
    assert.equal(problems.length, 4, problems.join("\n"));
    for (const target of ["docs/missing.md", "docs/ok.md#nope", "#nope-here", "../outside.md"]) {
      assert.ok(problems.some((line) => line.includes("README.md") && line.includes(target)), `no problem names ${target}:\n${problems.join("\n")}`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("docs check: unlinkedPages reports a page no link reaches", () => {
  assert.deepEqual(unlinkedPages(["docs/a.md", "docs/b.md"], new Set(["docs/a.md"])), ["docs/b.md"]);
});

/** README.md, CHANGELOG.md and every markdown page under docs outside docs/research, as paths from the repository root. */
function documentationFiles(): { rootDir: string; files: string[]; pages: string[] } {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const pages = readdirSync(new URL("../docs/", import.meta.url), { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("research/"))
    .map((entry) => "docs/" + entry)
    .sort();
  return { rootDir, files: ["README.md", "CHANGELOG.md", ...pages], pages };
}

test("docs check: every relative link and anchor in the README, the changelog and the docs resolves", () => {
  const { rootDir, files } = documentationFiles();
  assert.ok(files.length >= 15, `only ${files.length} documentation files found`);
  assert.deepEqual(linkProblems(rootDir, files, repoFromPackage()), []);
});

test("docs check: every docs page outside docs/research is linked from README.md", () => {
  const { pages } = documentationFiles();
  const repo = repoFromPackage();
  const linked = new Set<string>();
  for (const target of linkTargetsOf(readRepo("README.md"))) {
    const found = repoPathOf(target, "README.md", repo);
    if (found !== null && found.path !== "") linked.add(found.path);
  }
  assert.deepEqual(unlinkedPages(pages, linked), []);
});

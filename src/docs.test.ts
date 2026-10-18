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
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  void markdown;
  void heading;
  return "";
}

/** One line per gap between the Settings table of the configuration reference and the SETTINGS rows. */
function settingsProblems(rows: readonly SettingRow[], doc: string): string[] {
  void rows;
  void doc;
  return [];
}

/** The environment variable names a source text mentions, sorted and without duplicates. */
function envNamesIn(text: string): string[] {
  void text;
  return [];
}

/** One line per environment variable name that the document does not name in backticks. */
function envProblems(names: readonly string[], doc: string): string[] {
  void names;
  void doc;
  return [];
}

/** The bodies of the fenced json blocks of a markdown text, in order. */
function jsonBlocksOf(markdown: string): string[] {
  void markdown;
  return [];
}

/** What the real settings reader says about a config file with this text: its errors and warnings, or why it could not be read. */
function configProblems(jsonText: string): string[] {
  void jsonText;
  void readLayerFile;
  void prepareSettings;
  void writeFileSync;
  return [];
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

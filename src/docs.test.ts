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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "./index.js";
import { PI_FLAGS } from "./settings.js";
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

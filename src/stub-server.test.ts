import test from "node:test";
import assert from "node:assert/strict";
import { freePort, spawnStub, waitForHttp } from "./testkit.js";

test(
  "stub in ok mode answers the models and chat endpoints on the port it was given",
  { timeout: 20_000 },
  async (t) => {
    const port = await freePort();
    const child = spawnStub({ mode: "ok", port, model: "stub/model" });
    t.after(() => {
      child.kill("SIGKILL");
    });

    await waitForHttp(`http://127.0.0.1:${port}/v1/models`);

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(models.status, 200);
    const modelsBody = (await models.json()) as { data: Array<{ id: string }> };
    assert.equal(modelsBody.data[0]?.id, "stub/model");

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(chat.status, 200);
    const chatBody = (await chat.json()) as { choices: unknown[] };
    assert.ok(Array.isArray(chatBody.choices) && chatBody.choices.length > 0);
  },
);

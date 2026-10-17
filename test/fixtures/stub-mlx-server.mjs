// Stand-in for `mlx_lm.server`, used by the real-process tests.
//
// Accepts the same argv as the real server (--model, --host, --port) and
// selects a behaviour through the STUB_MODE environment variable.
import http from "node:http";

function parseArgs(argv) {
  const args = { model: "stub/model", host: "127.0.0.1", port: 8080 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--model" && value !== undefined) {
      args.model = value;
      i += 1;
    } else if (flag === "--host" && value !== undefined) {
      args.host = value;
      i += 1;
    } else if (flag === "--port" && value !== undefined) {
      args.port = Number(value);
      i += 1;
    }
  }
  return args;
}

const { model, host, port } = parseArgs(process.argv.slice(2));
const mode = process.env.STUB_MODE ?? "ok";
const listenDelayMs = Number(process.env.STUB_LISTEN_DELAY_MS ?? 0);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function drain(req) {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("error", resolve);
  });
}

function okHandler(req, res) {
  if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: model, object: "model" }] });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    drain(req).then(() => {
      json(res, 200, {
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
    });
    return;
  }
  json(res, 404, { error: "not found" });
}

function listen(handler) {
  const server = http.createServer(handler);
  const start = () => {
    server.listen(port, host, () => {
      process.stderr.write(`Starting httpd at ${host} on port ${port}...\n`);
    });
  };
  if (listenDelayMs > 0) {
    setTimeout(start, listenDelayMs);
  } else {
    start();
  }
  return server;
}

const modes = {
  ok() {
    listen(okHandler);
  },
};

const run = modes[mode];
if (run === undefined) {
  process.stderr.write(`stub-mlx-server: unknown STUB_MODE "${mode}"\n`);
  process.exit(2);
}
run();

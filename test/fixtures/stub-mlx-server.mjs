// Stand-in for `mlx_lm.server`, used by the real-process tests.
//
// Accepts the same argv as the real server (--model, --host, --port) and
// selects a behaviour through the STUB_MODE environment variable.
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
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

// Optionally record the exact argv so a test can prove which flags reached the process.
if (process.env.STUB_ARGV_FILE) {
  writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}

const { model, host, port } = parseArgs(process.argv.slice(2));
const mode = process.env.STUB_MODE ?? "ok";
const listenDelayMs = Number(process.env.STUB_LISTEN_DELAY_MS ?? 0);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// Collect the request body and resolve with its text.
function drain(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Optionally record every POST as one JSON line, { url, body }, so a test can prove what the server received.
// The body is the parsed JSON when the text parses and the raw text otherwise. Off unless STUB_REQUEST_FILE is set.
function record(url, text) {
  const file = process.env.STUB_REQUEST_FILE;
  if (!file) return;
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  appendFileSync(file, `${JSON.stringify({ url, body })}\n`);
}

function okHandler(req, res) {
  if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: model, object: "model" }] });
    return;
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    drain(req).then((text) => {
      record(req.url, text);
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

// Like ok, but the warm-up chat request is rejected with HTTP 400. The message
// can be lengthened with STUB_ERROR_PAD to exercise error-body truncation.
function warmup400Handler(req, res) {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const pad = Number(process.env.STUB_ERROR_PAD ?? 0);
    drain(req).then((text) => {
      record(req.url, text);
      json(res, 400, { error: `stub: unsupported request${"x".repeat(Math.max(0, pad))}` });
    });
    return;
  }
  okHandler(req, res);
}

// Write a whole buffer to a file descriptor, retrying when a non-blocking pipe
// is full (EAGAIN). A blocking pipe simply stalls inside writeSync until the
// reader drains it.
function writeFully(fd, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (err) {
      if (err.code !== "EAGAIN") throw err;
    }
  }
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

  // Reproduces the unread-stdout stall: the real server logs heavily before it
  // listens, and a launcher that never drains stdout blocks it forever.
  flood() {
    const kib = Number(process.env.STUB_FLOOD_KIB ?? 8192);
    const line = `${"x".repeat(1023)}\n`;
    for (let i = 0; i < kib; i += 1) {
      writeFully(1, line);
    }
    listen(okHandler);
  },

  // Dies during startup, e.g. a missing Python module.
  "exit-early"() {
    writeFully(1, "stub: starting up\n");
    writeFully(
      2,
      "Traceback (most recent call last):\n  File \"<stub>\", line 1, in <module>\nModuleNotFoundError: No module named 'mlx_lm'\n",
    );
    process.exit(3);
  },

  // Mirrors the real server when the port is taken: it prints the bind error
  // but the process neither exits nor serves.
  "bind-hang"() {
    const server = http.createServer(okHandler);
    server.on("error", (err) => {
      if (err.code !== "EADDRINUSE") {
        process.stderr.write(`stub-mlx-server: listen failed: ${err.message}\n`);
        process.exit(1);
      }
      process.stderr.write(
        "Traceback (most recent call last):\n  File \"<stub>\", line 1, in <module>\nOSError: [Errno 48] Address already in use\n",
      );
      setInterval(() => {}, 3_600_000);
    });
    server.listen(port, host, () => {
      process.stderr.write(`Starting httpd at ${host} on port ${port}...\n`);
    });
  },

  "warmup-400"() {
    listen(warmup400Handler);
  },

  // Accepts connections and never answers.
  hang() {
    listen(() => {});
  },

  "ignore-term"() {
    process.on("SIGTERM", () => {});
    listen(okHandler);
  },
};

const run = modes[mode];
if (run === undefined) {
  process.stderr.write(`stub-mlx-server: unknown STUB_MODE "${mode}"\n`);
  process.exit(2);
}
run();

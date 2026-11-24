import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { once } from "node:events";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";

const cleanups: Array<() => Promise<void>> = [];
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("no_proxy", "*");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function upstream() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.end("OK");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

async function connectProxy(target: URL) {
  const connections: Array<{
    destination: string | undefined;
    authorization: string | undefined;
  }> = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) =>
    response.writeHead(502).end(),
  );
  server.on("connect", (request, client, head) => {
    connections.push({
      destination: request.url,
      authorization: request.headers["proxy-authorization"],
    });
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No proxy port");
  return { url: `http://user:pass@127.0.0.1:${address.port}`, connections };
}

it("routes an account through a CONNECT proxy and bypasses it for the default transport", async () => {
  const target = await upstream();
  const targetUrl = new URL(target.url);
  const first = await connectProxy(targetUrl);
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const firstFetch = transport.fetchVia(first.url);
  const directFetch = transport.fetchVia(null);

  expect(await (await directFetch(target.url)).text()).toBe("OK");
  expect(first.connections).toEqual([]);
  expect(await (await firstFetch(target.url)).text()).toBe("OK");
  await transport.forget(first.url);
  expect(await (await transport.fetchVia(first.url)(target.url)).text()).toBe(
    "OK",
  );
  const authenticatedConnect = {
    destination: targetUrl.host,
    authorization: `Basic ${Buffer.from("user:pass").toString("base64")}`,
  };
  expect(first.connections).toEqual([
    authenticatedConnect,
    authenticatedConnect,
  ]);
  expect(target.requests()).toBe(3);
});

it("caches separate agents per proxy and destroys all dispatchers", async () => {
  const dispatchers: Dispatcher[] = [];
  vi.stubGlobal(
    "fetch",
    async (_input: unknown, init: { dispatcher: Dispatcher }) => {
      dispatchers.push(init.dispatcher);
      return new Response();
    },
  );
  const transport = createUpstreamTransport();
  const target = "https://upstream.invalid";
  cleanups.push(transport.destroy);
  const first = "http://user:pass@proxy.invalid:3128";
  const second = "https://user:pass@other.invalid:8443";
  expect(transport.fetchVia(null)).toBe(transport.fetch);
  for (const proxy of [null, first, first, second]) {
    await transport.fetchVia(proxy)(target);
  }
  expect(dispatchers[1]).toBe(dispatchers[2]);
  const unique = new Set(dispatchers);
  expect(unique.size).toBe(3);
  for (const dispatcher of unique)
    expect(dispatcher).toHaveProperty("destroyed", false);
  await transport.destroy();
  for (const dispatcher of unique)
    expect(dispatcher).toHaveProperty("destroyed", true);
});

it("closes a forgotten proxy agent and creates a new agent for the same address", async () => {
  const dispatchers: Dispatcher[] = [];
  vi.stubGlobal(
    "fetch",
    async (_input: unknown, init: { dispatcher: Dispatcher }) => {
      dispatchers.push(init.dispatcher);
      return new Response("OK");
    },
  );
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const proxy = "http://user:pass@proxy.invalid:3128";
  const target = "https://upstream.invalid";

  expect(await (await transport.fetchVia(proxy)(target)).text()).toBe("OK");
  await transport.forget(proxy);
  expect(dispatchers[0]).toHaveProperty("closed", true);
  expect(await (await transport.fetchVia(proxy)(target)).text()).toBe("OK");
  expect(dispatchers[1]).not.toBe(dispatchers[0]);
  expect(dispatchers[1]).toHaveProperty("closed", false);
});

it("keeps the connection error code while removing proxy credentials from errors", async () => {
  const proxy = "http://user:pass@proxy.invalid:3128";
  vi.stubGlobal("fetch", async () => {
    throw new Error("fetch failed", {
      cause: Object.assign(new Error(proxy), { code: "ECONNREFUSED" }),
    });
  });
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const result = transport.fetchVia(proxy)("https://upstream.invalid");
  await expect(result).rejects.toMatchObject({
    message: "Account Pooler proxy connection failed.",
    code: "ECONNREFUSED",
  });
  await expect(result).rejects.not.toHaveProperty("cause");
});

it("uses an independent transport when the default dispatcher retains a destroyed HTTP/2 session", async () => {
  const cause = Object.assign(new Error("The session has been destroyed"), {
    code: "ERR_HTTP2_INVALID_SESSION",
  });
  const brokenDefault = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit & { dispatcher?: Dispatcher },
  ) => {
    if (init?.dispatcher === undefined) {
      throw new TypeError("fetch failed", { cause });
    }
    return nativeFetch(input, init);
  };
  vi.stubGlobal("fetch", brokenDefault);
  const target = await upstream();
  await expect(fetch(target.url)).rejects.toMatchObject({
    cause: {
      code: "ERR_HTTP2_INVALID_SESSION",
      message: "The session has been destroyed",
    },
  });
  expect(target.requests()).toBe(0);
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  for (let i = 0; i < 2; i++) {
    const response = await transport.fetch(target.url, {
      method: "POST",
      body: "hello",
    });
    expect(await response.text()).toBe("OK");
  }
  expect(target.requests()).toBe(2);
});

it("negotiates HTTP/1.1 when the upstream also offers HTTP/2", async () => {
  const cert = new URL("./fixtures/localhost-cert.pem", import.meta.url);
  const key = new URL("./fixtures/localhost-key.pem", import.meta.url);
  const server = http2.createSecureServer({
    cert: await readFile(cert),
    key: await readFile(key),
    allowHTTP1: true,
  });
  let alpn: string | false | undefined;
  server.on("secureConnection", (socket) => {
    alpn = socket.alpnProtocol;
  });
  server.on("request", (request, response) => {
    response.end(JSON.stringify({ httpVersion: request.httpVersion, alpn }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const moduleUrl = new URL("./upstream-transport.ts", import.meta.url);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { createUpstreamTransport } from ${JSON.stringify(moduleUrl.href)};
      const transport = createUpstreamTransport();
      try {
        const response = await transport.fetch("https://127.0.0.1:${address.port}");
        console.log(await response.text());
      } finally {
        await transport.destroy();
      }
    `,
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(cert) },
      timeout: 10_000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({ httpVersion: "1.1", alpn: "http/1.1" });
}, 15_000);

it("releases its connections on disposal and refuses later requests", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  expect(await (await transport.fetch(target.url)).text()).toBe("OK");
  await transport.destroy();
  await expect(transport.fetch(target.url)).rejects.toThrow();
  expect(target.requests()).toBe(1);
});

it("preserves cancellation without sending a request", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.fetch(target.url, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(target.requests()).toBe(0);
});

it("does not replay an accepted POST whose response connection fails", async () => {
  let requests = 0;
  const server = http.createServer((request) => {
    request.resume();
    request.on("end", () => {
      requests++;
      request.socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  await expect(
    transport.fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      body: "hello",
    }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

it("does not expose arbitrary error messages or unrecognized codes", () => {
  const error = Object.assign(new Error("secret-token"), {
    code: "SECRET_TOKEN",
  });
  expect(transportErrorCode(error)).toBe("unclassified transport error");
  error.cause = error;
  expect(transportErrorCode(error)).toBe("unclassified transport error");
});

import {
  EnvHttpProxyAgent,
  Pool,
  ProxyAgent,
  Socks5ProxyAgent,
  type Dispatcher,
} from "undici";

import { isIP } from "node:net";
import type { PoolProvider, ProxyCheckResult, ProxyExit } from "./contracts.js";

export async function proxyExit(
  fetchThroughProxy: typeof fetch,
): Promise<ProxyExit> {
  try {
    const response = await fetchThroughProxy(
      "https://www.cloudflare.com/cdn-cgi/trace",
      {
        redirect: "error",
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = await response.text();
    const ip = /^ip=([^\r\n]+)$/m.exec(body)?.[1];
    const country = /^loc=([A-Z]{2})$/m.exec(body)?.[1];
    return ip && isIP(ip) && country ? { ip, country } : null;
  } catch {
    return null;
  }
}

export async function checkProxyConnection(
  provider: PoolProvider,
  proxy: string,
  fetchVia?: (proxy: string) => typeof fetch,
): Promise<ProxyCheckResult> {
  const target =
    provider === "codex"
      ? "https://chatgpt.com/backend-api/codex/models"
      : "https://api.anthropic.com/v1/models";
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const transport = fetchVia ? null : createUpstreamTransport();
  const signal = AbortSignal.timeout(10_000);
  try {
    const send = (fetchVia ?? transport!.fetchVia)(proxy);
    const response = await send(target, {
      method: "HEAD",
      redirect: "manual",
      signal,
    });
    const { status } = response;
    await response.body?.cancel();
    return {
      connected: status !== 407,
      status,
      elapsedMs: elapsed(),
      message:
        status === 407
          ? "Прокси отклонил авторизацию."
          : `Получен ответ от ${new URL(target).hostname} через прокси.`,
    };
  } catch (error) {
    const code = transportErrorCode(error);
    if (code === "PROXY_AUTH_REQUIRED") {
      return {
        connected: false,
        status: 407,
        elapsedMs: elapsed(),
        message: "Прокси отклонил авторизацию.",
      };
    }
    const message =
      signal.aborted || code.includes("TIMEOUT") || code === "ETIMEDOUT"
        ? "Истекло время ожидания соединения."
        : code === "ECONNREFUSED"
          ? "Прокси отклонил соединение."
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? "Не удалось определить адрес сервера."
            : "Соединение не установлено. Проверьте адрес и данные доступа к прокси.";
    return { connected: false, status: null, elapsedMs: elapsed(), message };
  } finally {
    await transport?.destroy();
  }
}

function fetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return (input, init) => {
    const options = { ...init, dispatcher };
    return fetch(input, options);
  };
}

function createHttpTunnelPool(
  origin: string | URL,
  options: Pool.Options,
): Pool {
  const connectTunnel = options.connect;
  if (typeof connectTunnel !== "function")
    throw new Error("Missing proxy tunnel connector.");
  return new Pool(origin, {
    ...options,
    connect(target, callback) {
      connectTunnel(target, (error, socket) => {
        if (error && transportErrorCode(error) === "UND_ERR_SOCKET") {
          callback(
            Object.assign(new Error("Proxy tunnel closed during setup."), {
              code: "ECONNRESET",
            }),
            null,
          );
        } else if (error) callback(error, null);
        else callback(null, socket);
      });
    },
  });
}

export function createUpstreamTransport() {
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });
  const upstreamFetch = fetchWithDispatcher(dispatcher);
  const proxies = new Map<string, { agent: Dispatcher; fetch: typeof fetch }>();
  const closing = new Set<Dispatcher>();
  let destroyed = false;
  return {
    fetch: upstreamFetch,
    fetchVia(proxyUrl: string | null): typeof fetch {
      if (proxyUrl === null) return upstreamFetch;
      const existing = proxies.get(proxyUrl);
      if (existing !== undefined) return existing.fetch;
      if (destroyed) throw new Error("Account Pooler transport is closed.");
      let agent: Dispatcher;
      try {
        const url = new URL(proxyUrl);
        if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
          url.protocol = "socks5:";
          agent = new Socks5ProxyAgent(url);
        } else {
          agent = new ProxyAgent({
            uri: proxyUrl,
            allowH2: false,
            factory: createHttpTunnelPool,
          });
        }
      } catch {
        return async () => {
          throw new Error(
            "Account Pooler could not initialize the account proxy.",
          );
        };
      }
      const dispatch = fetchWithDispatcher(agent);
      const proxyFetch: typeof fetch = async (input, init) => {
        try {
          return await dispatch(input, init);
        } catch (error) {
          throw Object.assign(
            new Error("Account Pooler proxy connection failed."),
            {
              code: transportErrorCode(error),
            },
          );
        }
      };
      proxies.set(proxyUrl, { agent, fetch: proxyFetch });
      return proxyFetch;
    },
    async forget(proxyUrl: string): Promise<void> {
      const proxy = proxies.get(proxyUrl);
      if (proxy === undefined) return;
      proxies.delete(proxyUrl);
      closing.add(proxy.agent);
      try {
        await proxy.agent.close();
      } finally {
        closing.delete(proxy.agent);
      }
    },
    async destroy(): Promise<void> {
      destroyed = true;
      await Promise.all([
        dispatcher.destroy(),
        ...Array.from(proxies.values(), ({ agent }) => agent.destroy()),
        ...Array.from(closing, (agent) => agent.destroy()),
      ]);
      proxies.clear();
    },
  };
}

const TRANSPORT_CODES = new Set([
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_GOAWAY_SESSION",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_PRX_TLS",
  "PROXY_AUTH_REQUIRED",
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

export function transportErrorCode(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    if (
      cause.message === "Proxy response (407) !== 200 when HTTP Tunneling" ||
      cause.message === "Proxy Authentication Required (407)"
    )
      return "PROXY_AUTH_REQUIRED";
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      TRANSPORT_CODES.has(cause.code)
    ) {
      return cause.code;
    }
    cause = cause.cause;
  }
  return "unclassified transport error";
}

import { EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";

function fetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return (input, init) => {
    const options = { ...init, dispatcher };
    return fetch(input, options);
  };
}

export function createUpstreamTransport() {
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });
  const upstreamFetch = fetchWithDispatcher(dispatcher);
  const proxies = new Map<string, { agent: ProxyAgent; fetch: typeof fetch }>();
  const closing = new Set<ProxyAgent>();
  let destroyed = false;
  return {
    fetch: upstreamFetch,
    fetchVia(proxyUrl: string | null): typeof fetch {
      if (proxyUrl === null) return upstreamFetch;
      const existing = proxies.get(proxyUrl);
      if (existing !== undefined) return existing.fetch;
      if (destroyed) throw new Error("Account Pooler transport is closed.");
      let agent: ProxyAgent;
      try {
        agent = new ProxyAgent({ uri: proxyUrl, allowH2: false });
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

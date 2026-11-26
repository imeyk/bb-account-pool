# Account Pooler (Fork)

Choose which Claude Code or Codex account handles a conversation in bb. Pick an account from the composer, or let the pool choose one based on its remaining weekly quota. Each account can have its own outbound proxy.

The plugin lives in [plugins/account-pool](plugins/account-pool). This branch is based on [bb 0.50.1](https://github.com/get-bb/bb/tree/desktop-v0.50.1) and includes the bb workspace used to build and test the plugin.

## Use the pool

1. In a bb instance running this fork, open **Settings → Plugins → Account Pooler (Fork)**, enable the plugin, and add a Claude or Codex account
2. In a thread, open **+ → Аккаунт**. Pick an account for the next request or select **Авто**. Choosing an account from another provider uses bb's model selection and continues the conversation in a new thread
3. To change how **Авто** chooses an account, open **Advanced → Режим ротации** in the plugin settings. The default prefers the eligible account with the lowest known weekly usage for a new conversation. Existing conversations keep their account while it remains available

## Per-account proxies

Open the account's menu and choose **Set proxy…** to configure an HTTP, HTTPS or SOCKS5 proxy. Use **Проверить соединение** to test the saved address or a replacement before saving. The settings page shows the exit IP and country observed through that proxy. The account picker shows the same country's flag.

If the connection drops before a response starts, the pool can retry twice through the same proxied account. If the proxy stays down, the request fails without falling back to a direct connection. Once streaming has started, an interruption is reported to the client.

See the [routing and CLI guide](plugins/account-pool/skills/account-pool/references/accounts-and-routing.md) for sign-in, account priorities, quota windows and proxy commands.

## Run from source

Use Node.js 22.19 or newer and the repository's pinned pnpm 9.15. Run these commands from a machine with Git and Corepack:

```sh
git clone --depth 1 --branch account-pool https://github.com/imeyk/bb-account-pool.git
cd bb-account-pool
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by the launcher. This starts a development instance with its own bb data directory and account settings.

To check the plugin and build its bundled runtime, run from the repository root:

```sh
pnpm exec turbo run typecheck test prepare:bundled --filter=bb-plugin-account-pool
```

The build output is `plugins/account-pool/.bundled-runtime/`. The plugin uses bb's workspace SDK, shared UI and build tools.

## License

[MIT](LICENSE). The bundled country flags include their own [artwork license](plugins/account-pool/skills/account-pool/references/flag-artwork-license.txt).

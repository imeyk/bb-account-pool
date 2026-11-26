Keep a Claude Code or Codex thread running when one account hits its limit. The Account Pooler puts every account you own behind a local hub and picks the account for each request.

## What you get

- Claude and Codex accounts added by signing in (browser or device code) or with an Anthropic API key. Each holds its own login, so the pool never signs this machine's Claude Code or Codex out; **Sign in again** renews one in place.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their account until the provider refuses it.
- Drag handles (or Space and arrow keys) set the account order within each provider in settings, as does `bb pool account reorder <claude|codex> <id>...`.
- Live limit windows per account and model family in settings, and the same numbers from `bb pool status`.
- A routing switch per provider and a bypass per thread, so one thread can go straight to its own credentials.

## How it works

The hub serves Anthropic Messages and OpenAI Responses endpoints. Routed providers report **Proxied** and receive a machine-scoped hub token. Accounts in error are skipped. Accounts below the switch threshold (default 98 percent) go first; accounts above it still serve until the provider refuses them. Claude extra usage and Codex credits come last, and conversations return when quota recovers. Accounts past the threshold are rechecked before fallback. Codex spending-control and explicit credit-depletion restrictions block routing even below the threshold. The pool does not enable extra usage, purchase credits, or change spending limits. Settings shows “Extra usage available” only for reported allowance, never current billing activity. Secrets stay on the server and tokens refresh in the background.

The pool waits once on the same account for short temporary rate limits. Longer holds return Retry-After for pinned conversations while new conversations can advance. A model-family limit detours requests for that family without moving the session’s main pin or the provider cursor. Server, overload and connection errors retry a pinned account twice with backoff before failing over. The pool commits a new account after a successful response; failing everywhere keeps the old binding. The current account and pins survive hub restarts; pins expire after 30 idle minutes, and the 4,096 most recent are kept.

Each account can use its own HTTP(S) or SOCKS5 proxy for provider requests, sign-in, token refresh and usage. In the account menu, **Set proxy…** → **Проверить соединение** tests the saved or entered address. Use `bb pool account proxy-check <id> [--proxy-stdin]` from the CLI. Nested BB servers can use the parent pool.

Choose the rotation policy under **Advanced** → **Режим ротации** or with `bb pool rotation <weekly|sequential>`.

Open the composer’s + menu and select "Аккаунт". The menu groups pool accounts by provider. A different provider uses BB’s model selection and continues in a new thread through its native handoff. In a new thread, enter the prompt first and send it from the account picker. In an existing thread, choosing an account saves it for the next request. Auto prefers the lowest observed weekly usage for new conversations. CLI: `bb pool thread choose <thread-id> <account-id|auto>`.

## Requirements

Accounts you own and are permitted to use this way.

Experimental: routing, storage, and CLI may change.

## For agents

`bb pool account add|login|list|remove|enable|disable|priority|proxy|reorder`, `bb pool status`, `bb pool routing <claude|codex> [--off]`, `bb pool config`, `bb pool config set`, `bb pool parent [proxy|isolate]`, `bb pool token rotate`, and `bb pool bypass <thread-id>`. Every command takes `--json` and `--help`; `bb pool --help` lists the commands and `bb pool <command> --help` prints its arguments, options, and rules.

## Automatic retries

Provider Retry uses pool recovery times. Inspect `bb provider-retry status` or `bb provider-retry explain <thread-id>`.

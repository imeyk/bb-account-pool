import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountAddInputSchema,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  accountIdInputSchema,
  accountPriorityInputSchema,
  accountReorderInputSchema,
  accountSchema,
  accountSetProxyInputSchema,
  proxyCheckInputSchema,
  proxyEditorInput,
  proxyExitSchema,
  proxyCheckResultSchema,
  rotationModeSchema,
  accountSummarySchema,
  bypassInputSchema,
  codexLoginCancelSchema,
  codexLoginPollInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  hubTokenSummarySchema,
  loginCompleteInputSchema,
  loginStartSchema,
  loginTargetSchema,
  routedThreadStatusListSchema,
  statusSchema,
  tokenRotateInputSchema,
  routingSetInputSchema,
  type AccountPoolConfigController,
} from "./contracts.js";
import type { PoolOperations } from "./operations.js";
import type { ClaudeOAuthLogin } from "./oauth-login.js";
import type { CodexDeviceLogin } from "./codex-device-login.js";

export const accountPoolRpcContract = defineRpcContract({
  "thread.choice": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.string().uuid().nullable(),
  },
  "thread.choose": {
    input: z
      .object({
        threadId: z.string().min(1),
        accountId: z.string().uuid().nullable(),
      })
      .strict(),
    output: z.string().uuid().nullable(),
  },
  "account.add": {
    input: accountAddInputSchema,
    output: accountSchema,
  },
  "account.list": {
    input: z.null(),
    output: z.array(accountSummarySchema),
  },
  "account.remove": {
    input: accountIdInputSchema,
    output: z.object({ removed: z.boolean() }).strict(),
  },
  "account.enable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.disable": {
    input: accountIdInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "routing.setRotationMode": {
    input: rotationModeSchema,
    output: z.null(),
  },
  "account.proxyExit": { input: accountIdInputSchema, output: proxyExitSchema },
  "account.saveProxyFields": {
    input: proxyEditorInput,
    output: accountSummarySchema.nullable(),
  },
  "account.checkProxyFields": {
    input: proxyEditorInput,
    output: proxyCheckResultSchema,
  },
  "account.checkProxy": {
    input: proxyCheckInputSchema,
    output: proxyCheckResultSchema,
  },
  "account.setProxy": {
    input: accountSetProxyInputSchema,
    output: accountSummarySchema.nullable(),
  },
  "account.setPriority": {
    input: accountPriorityInputSchema,
    output: z.object({ account: accountSchema.nullable() }).strict(),
  },
  "account.reorder": {
    input: accountReorderInputSchema,
    output: z.null(),
  },
  "account.refreshUsage": {
    input: z.object({ accountId: z.string().uuid() }).strict(),
    output: z.object({ account: accountSummarySchema.nullable() }).strict(),
  },
  "routing.set": {
    input: routingSetInputSchema,
    output: z
      .object({ provider: z.enum(["claude", "codex"]), enabled: z.boolean() })
      .strict(),
  },
  "config.get": {
    input: z.null(),
    output: accountPoolConfigSchema,
  },
  "config.set": {
    input: accountPoolConfigSetInputSchema,
    output: accountPoolConfigSchema,
  },
  "login.start": {
    input: loginTargetSchema,
    output: loginStartSchema,
  },
  "login.complete": {
    input: loginCompleteInputSchema,
    output: accountSchema,
  },
  "codexLogin.start": {
    input: loginTargetSchema,
    output: codexLoginStartSchema,
  },
  "codexLogin.poll": {
    input: codexLoginPollInputSchema,
    output: codexLoginPollSchema,
  },
  "codexLogin.cancel": {
    input: codexLoginPollInputSchema,
    output: codexLoginCancelSchema,
  },
  "status.get": {
    input: z.null(),
    output: statusSchema,
  },
  "status.routedThreads": {
    input: z.null(),
    output: routedThreadStatusListSchema,
  },
  "token.rotate": {
    input: tokenRotateInputSchema,
    output: hubTokenSummarySchema,
  },
  "bypass.set": {
    input: bypassInputSchema,
    output: bypassInputSchema,
  },
});

export function createRpcHandlers(
  operations: PoolOperations,
  login: ClaudeOAuthLogin,
  codexLogin: CodexDeviceLogin,
  config: AccountPoolConfigController,
): PluginRpcHandlers<typeof accountPoolRpcContract> {
  return {
    "thread.choice": ({ threadId }) => operations.threadChoice(threadId),
    "thread.choose": ({ threadId, accountId }) =>
      operations.setThreadChoice(threadId, accountId),
    "account.add": (input) => operations.add(input),
    "account.list": () => operations.list(),
    "account.remove": async ({ id }) => ({
      removed: await operations.remove(id),
    }),
    "account.enable": async ({ id }) => ({
      account: await operations.enable(id),
    }),
    "account.disable": async ({ id }) => ({
      account: await operations.disable(id),
    }),
    "routing.setRotationMode": async (mode) => {
      await operations.setRotationMode(mode);
      return null;
    },
    "account.proxyExit": ({ id }) => operations.proxyExit(id),
    "account.saveProxyFields": async ({ id, fields }) =>
      operations.setProxy(id, await operations.editorAddress(id, fields)),
    "account.checkProxyFields": async ({ id, fields }) =>
      operations.checkProxy(id, await operations.editorAddress(id, fields)),
    "account.checkProxy": ({ id, proxy }) => operations.checkProxy(id, proxy),
    "account.setProxy": ({ id, proxy }) => operations.setProxy(id, proxy),
    "account.setPriority": async ({ accountId, priority }) => ({
      account: await operations.setPriority(accountId, priority),
    }),
    "account.refreshUsage": async ({ accountId }) => ({
      account: await operations.refreshUsage(accountId),
    }),
    "account.reorder": async ({ provider, accountIds }) => {
      await operations.reorder(provider, accountIds);
      return null;
    },
    "routing.set": async ({ provider, enabled }) => {
      await operations.setRouting(provider, enabled);
      return { provider, enabled };
    },
    "config.get": () => config.get(),
    "config.set": (input) => config.set(input),
    "login.start": (target) => login.start(target),
    "login.complete": (input) => login.complete(input),
    "codexLogin.start": (target) => codexLogin.start(target),
    "codexLogin.poll": (input) => codexLogin.poll(input),
    "codexLogin.cancel": (input) => ({
      cancelled: codexLogin.cancel(input),
    }),
    "status.get": () => operations.status(),
    "status.routedThreads": () => operations.routedThreadsWithoutLocalLogin(),
    "token.rotate": ({ machine }) => operations.rotateToken(machine),
    "bypass.set": ({ threadId, bypassed }) =>
      operations.setBypass(threadId, bypassed),
  };
}

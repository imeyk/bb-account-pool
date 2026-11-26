import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  experimental_copyToClipboard,
  useBbNavigate,
  useComposer,
  useSdk,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ResourceRowDetailChevron } from "@/components/ui/resource-list";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  LimitWindowSlot,
  LoginTarget,
  ModelFamily,
  PoolAvailability,
  PoolProvider,
  PoolStatus,
  ProxyCheckResult,
  ProxyFields,
  ProxyExit,
} from "./src/contracts.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import type { OAuthLoginStart } from "./src/oauth-login.js";
import type { CodexDeviceLoginStart } from "./src/codex-device-login.js";
import countryFlagImages from "./src/flags/countries.json";
import {
  DEFAULT_ACCOUNT_POOL_CONFIG,
  limitWindowSlotSchema,
  modelFamilySchema,
  proxyUrlSchema,
  proxyFieldsSchema,
  proxySchemeSchema,
  rotationModeSchema,
  statusSchema,
} from "./src/contracts.js";
import { blockingResetAt } from "./src/quota.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

type DialogState =
  | { kind: "account" | "priority" | "proxy" | "remove"; accountId: string }
  | { kind: "new-login"; provider: PoolProvider }
  | { kind: "claude-login" | "codex-login"; target: LoginTarget }
  | { kind: "api-key" }
  | null;

const NEW_LOGIN: LoginTarget = { kind: "add", label: null, priority: 100 };

type ConfigField = Exclude<keyof AccountPoolConfig, "parentMode">;

const CONFIG_FIELDS: readonly ConfigField[] = [
  "anthropicUpstreamBaseUrl",
  "codexUpstreamBaseUrl",
  "switchThreshold",
];

const ACCOUNT_ACTIONS = [
  "toggle",
  "priority",
  "proxy",
  "refresh",
  "relogin",
  "remove",
] as const;

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description:
      "Claude Code threads on every machine route through these accounts.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Codex threads route through these ChatGPT accounts.",
  },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function parentHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function parentBannerBody(parent: NonNullable<PoolStatus["parent"]>): string {
  const host = parentHost(parent.baseUrl);
  if (parent.mode !== "proxy") {
    return `This server was started from a thread on ${host}. Turn this on to send Claude and Codex requests to its pool instead of using the accounts below.`;
  }
  const served = PROVIDERS.filter(
    (provider) => parent.availability[provider.id],
  ).map((provider) => provider.title);
  if (served.length === 0) {
    return `${host} has no accounts available right now, so nothing is being sent there. Requests fall back to each provider's own credentials.`;
  }
  const missing = PROVIDERS.filter(
    (provider) => !parent.availability[provider.id],
  ).map((provider) => provider.title);
  const routed = `${served.join(" and ")} requests are sent to the pool on ${host}.`;
  return missing.length === 0
    ? `${routed} Accounts on this server are not used while this is on.`
    : `${routed} ${missing.join(" and ")} has no accounts there, so those requests fall back to their own credentials.`;
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
function windowShortLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "LIMIT" : "LIMIT 2";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}D`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}H`;
  return `${window.windowMinutes}M`;
}
function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;
  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;
  return `${window.windowMinutes} minute`;
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;
  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}
const STATUS_CACHE_KEY = "account-pool:status";

function readCachedStatus(): PoolStatus | null {
  try {
    const raw = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (raw === null) return null;
    const parsed = statusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: PoolStatus): void {
  try {
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    return;
  }
}

function statusPresentation(account: AccountSummary): {
  label: string;
  dot: string;
} {
  if (account.status === "held")
    return {
      label: `Held${account.heldUntil === null ? "" : ` · retry at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted") {
    const resetAt = blockingResetAt(account, null, Date.now());
    return {
      label: `Exhausted${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-destructive",
    };
  }
  if (account.status === "error")
    return { label: "Error", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };
  return { label: "Ready", dot: "bg-success" };
}
function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API key" : "OAuth")
  );
}
function secondaryEmail(account: AccountSummary): string | null {
  return account.email === null || account.email === account.label
    ? null
    : account.email;
}
function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function agentProviderId(provider: string): string {
  return provider === "claude" ? "claude-code" : provider;
}

function ProviderLabel({
  provider,
  title,
}: {
  provider: PoolProvider;
  title?: string;
}) {
  const { providers } = experimental_useProviders();
  const id = agentProviderId(provider);
  const entry = providers.find((item) => item.id === id);
  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon
        providerKind="agent"
        provider={entry ?? { id }}
        fallback="Bot"
        className="size-4 shrink-0"
        aria-hidden="true"
      />
      <span>
        {title ??
          entry?.displayName ??
          PROVIDERS.find((item) => item.id === provider)?.title ??
          provider}
      </span>
    </span>
  );
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="@container/pool-section space-y-3">
      <div className="flex flex-col gap-3 @min-[36rem]/pool-section:flex-row @min-[36rem]/pool-section:items-start @min-[36rem]/pool-section:justify-between @min-[36rem]/pool-section:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

type QuotaSlot = {
  key: string;
  label: string;
  utilization: number | null;
  status: string | null;
};

const CLAUDE_WINDOW_LABELS = {
  primary: { short: "5H", long: "5 hour" },
  secondary: { short: "7D", long: "7 day" },
} as const satisfies Record<LimitWindowSlot, { short: string; long: string }>;

type DisplayWindow = {
  key: string;
  short: string;
  long: string;
  quota: FamilyQuota | null;
};

function displayWindows(account: AccountSummary): DisplayWindow[] {
  if (account.provider === "codex")
    return account.limitWindows.map((window) => ({
      key: window.slot,
      short: windowShortLabel(window),
      long: windowLongLabel(window),
      quota: window,
    }));
  const observed =
    account.limitWindows.length === 0
      ? limitWindowSlotSchema.options.map((slot) => ({ slot, quota: null }))
      : account.limitWindows.map((window) => ({
          slot: window.slot,
          quota: window,
        }));
  return observed.map(({ slot, quota }) => ({
    key: slot,
    ...CLAUDE_WINDOW_LABELS[slot],
    quota,
  }));
}

function quotaSlots(account: AccountSummary): QuotaSlot[] {
  const windows = displayWindows(account).map((window) => ({
    key: window.key,
    label: window.short,
    utilization: window.quota?.utilization ?? null,
    status: window.quota?.status ?? null,
  }));
  if (account.provider === "codex")
    return windows.length === 0
      ? [{ key: "primary", label: "LIMIT", utilization: null, status: null }]
      : windows;
  return [
    ...windows,
    {
      key: "fable",
      label: "FABLE",
      utilization: account.familyWeekly.fable?.utilization ?? null,
      status: account.familyWeekly.fable?.status ?? null,
    },
  ];
}

function quotaToneClass(slot: QuotaSlot, threshold: number): string {
  if (
    slot.status?.toLowerCase() === "rejected" ||
    (slot.utilization !== null && slot.utilization >= 1)
  )
    return "text-destructive-text";
  if (slot.utilization !== null && slot.utilization >= threshold - 0.1)
    return "text-warning-text";
  return slot.utilization === null
    ? "text-subtle-foreground/75"
    : "text-foreground";
}

function QuotaValue({
  slot,
  threshold,
  refreshing,
}: {
  slot: QuotaSlot;
  threshold: number;
  refreshing: boolean;
}) {
  return (
    <div
      className={cn(
        "w-16 text-left tabular-nums transition-opacity @min-[32rem]/account-row:text-right",
        refreshing && "opacity-50",
      )}
    >
      <div className="text-2xs uppercase tracking-wide text-subtle-foreground/75">
        {slot.label}
      </div>
      <div
        className={cn("text-xs font-semibold", quotaToneClass(slot, threshold))}
      >
        {percent(slot.utilization)}
      </div>
    </div>
  );
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

function AccountRow({
  account,
  threshold,
  pending,
  refreshing,
  onAction,
  onOpen,
  reorderDisabled,
}: {
  account: AccountSummary;
  threshold: number;
  pending: boolean;
  refreshing: boolean;
  onAction: (action: (typeof ACCOUNT_ACTIONS)[number]) => void;
  onOpen: () => void;
  reorderDisabled: boolean;
}) {
  const status = statusPresentation(account);
  const slots = quotaSlots(account);
  const email = secondaryEmail(account);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.id, disabled: pending || reorderDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "@container/account-row flex items-center gap-3 text-sm",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
        disabled={pending || reorderDisabled}
        aria-label={`Reorder ${account.label}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <div
        className={cn(
          "group relative -mx-2 flex min-w-0 flex-1 select-none items-center gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
          !account.enabled && "opacity-55",
        )}
      >
        <button
          type="button"
          className="grid min-w-0 flex-1 grid-cols-1 items-center gap-y-1.5 rounded-md text-left outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:ring-2 focus-visible:ring-ring @min-[32rem]/account-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/account-row:gap-y-0"
          aria-label={`Open ${account.label}`}
          onClick={onOpen}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {account.label}
              </span>
              {email === null ? null : (
                <span className="min-w-0 truncate text-xs text-subtle-foreground/75">
                  {email}
                </span>
              )}
              <SettingsBadge>{tier(account)}</SettingsBadge>
              {account.extraUsage?.status === "allowed" ? (
                <SettingsBadge>Extra usage available</SettingsBadge>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
              {account.proxy ? (
                <ProxyLocation
                  key={account.proxy.scheme + account.proxy.host}
                  id={account.id}
                  fallback={account.proxy.host}
                />
              ) : null}
              {account.lastUsedAt === null ? null : (
                <span>used {relative(account.lastUsedAt)}</span>
              )}
              {refreshing ? <span>refreshing usage…</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 @min-[32rem]/account-row:flex-nowrap @min-[32rem]/account-row:gap-1">
            {slots.map((slot) => (
              <QuotaValue
                key={slot.key}
                slot={slot}
                threshold={threshold}
                refreshing={refreshing}
              />
            ))}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="relative h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
              aria-label={`${account.label} actions`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("toggle")}
            >
              <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
              {account.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("priority")}
            >
              <Icon name="ListView" />
              Set priority…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("proxy")}
            >
              <Icon name="Globe" />
              Set proxy…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Refresh usage
            </DropdownMenuItem>
            {account.kind === "oauth" ? (
              <DropdownMenuItem
                disabled={pending}
                onSelect={() => onAction("relogin")}
              >
                <Icon name="UserRound" />
                Sign in again…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onSelect={() => onAction("remove")}
            >
              <Icon name="Trash2" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={`Open ${account.label} details`}
          className="relative"
          onClick={onOpen}
        >
          <ResourceRowDetailChevron />
        </button>
      </div>
    </div>
  );
}

function AddAccountMenu({
  provider,
  onChoose,
}: {
  provider: PoolProvider;
  onChoose: (choice: "login" | "api-key") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Add account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("login")}
        >
          <Icon name="UserRound" className="mt-0.5" />
          <span>
            <span className="block">
              Sign in to {provider === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {provider === "claude"
                ? "Opens claude.ai, paste the code back"
                : "Opens ChatGPT with a device code"}
            </span>
          </span>
        </DropdownMenuItem>
        {provider === "claude" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="items-start py-2"
              onSelect={() => onChoose("api-key")}
            >
              <Icon name="Lock" className="mt-0.5" />
              <span>
                <span className="block">Add API key…</span>
                <span className="block text-xs text-muted-foreground">
                  Metered fallback, never routes first
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · other accounts preferred from {Math.round(threshold * 100)}%
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "manual";

function useCopyToClipboard(text: string, selectFallback: () => void) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyState("idle");
  }, [text]);

  const copy = useCallback(() => {
    void experimental_copyToClipboard({ text }).then((copied) => {
      if (!copied) {
        selectFallback();
        setCopyState("manual");
        return;
      }
      setCopyState("copied");
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
    });
  }, [text, selectFallback]);

  return { copyState, copy };
}

function UserCodeBlock({ userCode }: { userCode: string }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const selectCode = useCallback(() => {
    const element = codeRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  const { copyState, copy } = useCopyToClipboard(userCode, selectCode);

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span
          ref={codeRef}
          className="col-start-2 select-all text-center font-mono text-2xl font-semibold tracking-widest"
          aria-label="Codex user code"
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Copy Codex sign-in code"
          className="col-start-3 size-9 justify-self-start text-muted-foreground hover:text-foreground max-sm:pointer-coarse:size-11"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Sign-in code copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The code is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function AuthorizationUrlRow({
  name,
  url,
  openUrl,
}: {
  name: string;
  url: string;
  openUrl: (url: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectUrl = useCallback(() => {
    inputRef.current?.select();
  }, []);
  const { copyState, copy } = useCopyToClipboard(url, selectUrl);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          aria-label={`${name} authorization URL`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Copy ${name} authorization URL`}
          onClick={copy}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Authorization URL copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The URL is selected; copy it manually."
            : ""}
      </span>
    </div>
  );
}

function initialProxy(saved: AccountSummary["proxy"] = null): ProxyFields {
  const url = saved && new URL(`${saved.scheme}://${saved.host}`);
  const scheme = saved?.scheme ?? "http";
  return {
    scheme,
    host: url?.hostname ?? "",
    port: url
      ? url.port ||
        (scheme === "http" ? "80" : scheme === "https" ? "443" : "1080")
      : "",
    user: saved?.authenticated ? null : "",
    password: saved?.authenticated ? null : "",
  };
}

function ProxyInput({
  fields,
  change,
}: {
  fields: ProxyFields;
  change: (fields: ProxyFields) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="col-span-2 grid gap-1 text-sm">
        Тип прокси
        <Select
          value={fields.scheme}
          onValueChange={(v) =>
            change({ ...fields, scheme: proxySchemeSchema.parse(v) })
          }
        >
          <SelectTrigger aria-label="Тип прокси">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {proxySchemeSchema.options.map((v) => (
              <SelectItem key={v} value={v}>
                {v.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {(["host", "port", "user", "password"] as const).map((key) => {
        const secret = key === "user" || key === "password";
        return (
          <label key={key} className="grid gap-1 text-sm">
            {
              {
                host: "IP или хост",
                port: "Порт",
                user: "Логин",
                password: "Пароль",
              }[key]
            }
            <Input
              type={secret ? "password" : "text"}
              autoComplete="off"
              inputMode={key === "port" ? "numeric" : undefined}
              value={fields[key] ?? ""}
              placeholder={fields[key] === null ? "••••••••" : undefined}
              onChange={(event) =>
                change({ ...fields, [key]: event.target.value })
              }
            />
          </label>
        );
      })}
      {fields.user === null || fields.password === null ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => change({ ...fields, user: "", password: "" })}
        >
          Очистить логин и пароль
        </Button>
      ) : null}
    </div>
  );
}

function useProxyExit(id: string) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [exit, setExit] = useState<ProxyExit | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void rpc.call("account.proxyExit", { id }).then(
        (value) => {
          if (active) setExit(value);
        },
        () => {
          if (active) setExit(null);
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 300000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, rpc]);
  return exit;
}

const countryNames = new Intl.DisplayNames(["ru"], {
  type: "region",
  fallback: "none",
});

const flagImages: Readonly<Record<string, string>> = countryFlagImages;

function CountryFlag({
  country,
  decorative = false,
}: {
  country?: string;
  decorative?: boolean;
}) {
  if (!country || !/^[A-Z]{2}$/.test(country) || country === "ZZ") return null;
  const name = countryNames.of(country);
  if (!name) return null;
  const src = flagImages[country];
  if (!src) return null;
  const label = `Страна прокси: ${name}`;
  return (
    <img
      src={src}
      width={16}
      height={12}
      className="shrink-0"
      alt={decorative ? "" : label}
      title={label}
    />
  );
}

function ProxyCountryFlag({ id }: { id: string }) {
  const exit = useProxyExit(id);
  return <CountryFlag country={exit?.country} />;
}

function ProxyLocation({ id, fallback }: { id: string; fallback: string }) {
  const exit = useProxyExit(id);
  return (
    <span className="break-all">
      {exit ? (
        <>
          Прокси ·{" "}
          <span className="inline-flex items-center gap-1 align-middle">
            <CountryFlag country={exit.country} decorative />
            {countryNames.of(exit.country) ?? exit.country}
          </span>
          {" · "}
          {exit.ip}
        </>
      ) : (
        `Прокси · ${fallback} · ${exit === undefined ? "проверяется" : "выходной IP неизвестен"}`
      )}
    </span>
  );
}

function DialogFrame({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <DialogContent
      hideCloseButton
      className={cn(
        "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose className="-mr-1 shrink-0 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <Icon name="X" className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto">{children}</div>
      {footer === null ? null : (
        <DialogFooter className="flex-row items-center gap-2 sm:space-x-0">
          {footer}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ProxyCheck({
  account,
  draft,
}: {
  account: AccountSummary;
  draft: ProxyFields;
}) {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ProxyCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = proxyFieldsSchema.safeParse(draft).success;
  async function check() {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await rpc.call("account.checkProxyFields", {
          id: account.id,
          fields: draft,
        }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="space-y-2">
      {account.proxy ? (
        <p className="break-all text-xs text-muted-foreground">
          Сохранённый прокси: {account.proxy.scheme}://{account.proxy.host}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={!available || checking}
        onClick={() => void check()}
      >
        {checking ? "Проверяется соединение…" : "Проверить соединение"}
      </Button>
      <p
        role="status"
        className={cn(
          "text-xs",
          error || result?.connected === false
            ? "text-destructive-text"
            : "text-muted-foreground",
        )}
      >
        {error ??
          (result
            ? `${result.message} ${result.status === null ? "" : `HTTP ${result.status}. `}${result.elapsedMs} мс.`
            : available
              ? "Проверяется введённый адрес без сохранения."
              : account.proxy
                ? "Для проверки будет использован сохранённый адрес."
                : "Введите адрес прокси для проверки.")}
      </p>
    </div>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(readCachedStatus);
  const [statusIsCached, setStatusIsCached] = useState(status !== null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigField, string>>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, boolean | null>>(
    () => new Map(),
  );
  const configSaving = CONFIG_FIELDS.some((field) =>
    pending.has(`config-${field}`),
  );
  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<OAuthLoginStart | null>(null);
  const [codexStep, setCodexStep] = useState<CodexDeviceLoginStart | null>(
    null,
  );
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fields, setFields] = useState<ProxyFields>(() => initialProxy());
  const [proxyRevision, setProxyRevision] = useState(0);
  function editProxy(next: ProxyFields) {
    setFields(next);
    setProxyRevision((n) => n + 1);
  }
  const blankProxy =
    !fields.host && !fields.port && !fields.user && !fields.password;
  const credentials =
    fields.user || fields.password
      ? `${encodeURIComponent(fields.user ?? "")}:${encodeURIComponent(fields.password ?? "")}@`
      : "";
  const proxyHost =
    fields.host.includes(":") && !fields.host.startsWith("[")
      ? `[${fields.host}]`
      : fields.host;
  const proxy = blankProxy
    ? ""
    : `${fields.scheme}://${credentials}${proxyHost}:${fields.port}`;
  const invalidNewProxy =
    !blankProxy &&
    (!proxyFieldsSchema.safeParse(fields).success ||
      !proxyUrlSchema.safeParse(proxy).success);
  const [priority, setPriority] = useState("100");
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      writeCachedStatus(next);
      if (!mounted.current) return;
      setStatus(next);
      setStatusIsCached(false);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);
      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(() => void poll(), codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(() => void poll(), codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];
  const loginTarget =
    dialog?.kind === "claude-login" || dialog?.kind === "codex-login"
      ? dialog.target
      : null;
  const reloginId =
    loginTarget?.kind === "relogin" ? loginTarget.accountId : null;
  const reloginAccount =
    accounts.find((account) => account.id === reloginId) ?? null;
  const selectedAccount =
    dialog?.kind === "account" ||
    dialog?.kind === "priority" ||
    dialog?.kind === "proxy" ||
    dialog?.kind === "remove"
      ? (accounts.find((account) => account.id === dialog.accountId) ?? null)
      : null;
  function markPending(key: string, target: boolean | null): void {
    setPending((current) => new Map(current).set(key, target));
  }
  function clearPending(key: string): void {
    setPending((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }
  async function run(
    key: string,
    action: () => Promise<void>,
    target: boolean | null = null,
  ): Promise<void> {
    if (pending.has(key)) return;
    markPending(key, target);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      clearPending(key);
    }
  }
  function switchValue(key: string, stored: boolean): boolean {
    return pending.get(key) ?? stored;
  }
  function accountPending(accountId: string): boolean {
    return ACCOUNT_ACTIONS.some((action) =>
      pending.has(`${action}-${accountId}`),
    );
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || configSaving) return;
    let update: AccountPoolConfigSetInput;
    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and at most 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    markPending(`config-${field}`, null);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      clearPending(`config-${field}`);
    }
  }
  async function startClaude(target: LoginTarget): Promise<void> {
    setDialog({ kind: "claude-login", target });
    setLoginDone(null);
    await run("claude-login", async () => {
      const started = await rpc.call("login.start", target);
      setLoginStep(started);
      setPastedCode("");
    });
  }
  async function startCodex(target: LoginTarget): Promise<void> {
    setDialog({ kind: "codex-login", target });
    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", target));
    });
  }
  async function startLogin(
    provider: PoolProvider,
    target: LoginTarget,
  ): Promise<void> {
    if (provider === "claude") await startClaude(target);
    else await startCodex(target);
  }
  function chooseAdd(
    provider: PoolProvider,
    choice: "login" | "api-key",
  ): void {
    setFields(initialProxy());
    setError(null);
    setDialog(
      choice === "login"
        ? { kind: "new-login", provider }
        : { kind: "api-key" },
    );
  }
  function saveProxy(id: string, address: string | null): void {
    void run(`proxy-${id}`, async () => {
      await rpc.call("account.setProxy", { id, proxy: address });
      closeDialog();
    });
  }
  async function accountAction(
    account: AccountSummary,
    action: (typeof ACCOUNT_ACTIONS)[number],
  ): Promise<void> {
    if (action === "priority") {
      setPriority(String(account.priority));
      setDialog({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "proxy") {
      setFields(initialProxy(account.proxy));
      setError(null);
      setDialog({ kind: "proxy", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDialog({ kind: "remove", accountId: account.id });
      return;
    }
    if (action === "relogin") {
      await startLogin(account.provider, {
        kind: "relogin",
        accountId: account.id,
      });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending.has(`order-${provider}`) || event.over === null) return;
    const ids = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const accountIds = arrayMove(ids, from, to);
    setOptimisticOrder({ provider, ids: accountIds });
    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }
  function closeDialog(): void {
    if (dialog?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDialog(null);
    setLoginStep(null);
    setCodexStep(null);
    setLoginDone(null);
    setFields(initialProxy());
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";
  const parent = status?.parent ?? null;
  const proxying = parent !== null && parent.mode === "proxy";
  return (
    <div className="w-full space-y-6">
      {parent === null ? null : (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {proxying
                  ? "Using the parent Account Pooler"
                  : "Parent Account Pooler available"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {parentBannerBody(parent)}
              </p>
            </div>
            <Switch
              checked={switchValue("parent-mode", proxying)}
              aria-label="Use the parent Account Pooler"
              onCheckedChange={(enabled) =>
                void run(
                  "parent-mode",
                  async () => {
                    await rpc.call("config.set", {
                      parentMode: enabled ? "proxy" : "isolate",
                    });
                  },
                  enabled,
                )
              }
            />
          </div>
        </div>
      )}
      <div
        className={proxying ? "space-y-6 opacity-50" : "space-y-6"}
        inert={proxying ? true : undefined}
      >
        <p className="text-xs text-subtle-foreground/75">
          Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
          {status?.inFlight ?? 0} in flight · used by {hubHosts}
          {statusIsCached ? " · refreshing…" : null}
        </p>
        {error === null ? null : (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
          >
            {error}
          </div>
        )}
        {status !== null && !statusIsCached && accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-5 py-6 text-center">
            <h2 className="text-sm font-semibold text-foreground">
              No accounts in the pool
            </h2>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
              Add a Claude or Codex account and threads on every machine will
              route through it. Your machine&apos;s own login keeps working
              until then.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => chooseAdd("claude", "login")}>
                Sign in to Claude
              </Button>
              <Button size="sm" onClick={() => chooseAdd("codex", "login")}>
                Sign in to Codex
              </Button>
            </div>
          </div>
        ) : null}
        {PROVIDERS.map((provider) => {
          const serverAccounts = accounts.filter(
            (account) => account.provider === provider.id,
          );
          const order =
            optimisticOrder?.provider === provider.id
              ? optimisticOrder.ids
              : null;
          const providerAccounts =
            order !== null &&
            order.length === serverAccounts.length &&
            serverAccounts.every((account) => order.includes(account.id))
              ? order.flatMap((id) =>
                  serverAccounts.filter((account) => account.id === id),
                )
              : serverAccounts;
          return (
            <SettingsSection
              key={provider.id}
              title={
                <ProviderLabel provider={provider.id} title={provider.title} />
              }
              description={provider.description}
              action={
                <div className="flex items-center gap-2">
                  <Switch
                    checked={switchValue(
                      `routing-${provider.id}`,
                      status?.routing[provider.id] ?? true,
                    )}
                    aria-label={`Route ${provider.title} threads`}
                    onCheckedChange={(enabled) =>
                      void run(
                        `routing-${provider.id}`,
                        async () => {
                          await rpc.call("routing.set", {
                            provider: provider.id,
                            enabled,
                          });
                        },
                        enabled,
                      )
                    }
                  />
                  <AddAccountMenu
                    provider={provider.id}
                    onChoose={(choice) => chooseAdd(provider.id, choice)}
                  />
                </div>
              }
            >
              {status === null ? (
                <p className="py-2.5 text-sm text-muted-foreground">Loading…</p>
              ) : providerAccounts.length === 0 ? (
                <p className="py-2.5 text-sm text-subtle-foreground">
                  No accounts yet.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={accountDragModifiers}
                  onDragEnd={(event) =>
                    void reorderAccounts(provider.id, event)
                  }
                >
                  <SortableContext
                    items={providerAccounts.map((account) => account.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="divide-y divide-border">
                      {providerAccounts.map((account) => (
                        <AccountRow
                          key={account.id}
                          account={account}
                          threshold={threshold}
                          pending={accountPending(account.id)}
                          refreshing={
                            statusIsCached ||
                            pending.has(`refresh-${account.id}`)
                          }
                          reorderDisabled={
                            providerAccounts.length < 2 ||
                            pending.has(`order-${provider.id}`)
                          }
                          onAction={(action) =>
                            void accountAction(account, action)
                          }
                          onOpen={() =>
                            setDialog({
                              kind: "account",
                              accountId: account.id,
                            })
                          }
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </SettingsSection>
          );
        })}
        <Collapsible className="rounded-lg border border-border px-4">
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
            <Icon
              name="ChevronRight"
              className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-border border-t border-border">
              <ConfigFieldRow
                label="Режим ротации"
                description="Как выбирать аккаунт в режиме Авто для новых диалогов Codex и Claude. Текущий диалог сохраняет привязку к аккаунту."
                error={null}
              >
                <Select
                  disabled={
                    status === null ||
                    statusIsCached ||
                    pending.has("rotation-mode")
                  }
                  value={status?.rotationMode ?? "weekly"}
                  onValueChange={(value) =>
                    void run("rotation-mode", async () => {
                      await rpc.call(
                        "routing.setRotationMode",
                        rotationModeSchema.parse(value),
                      );
                    })
                  }
                >
                  <SelectTrigger
                    aria-label="Режим ротации"
                    className="h-8 w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="weekly">
                      Наименьший недельный расход
                    </SelectItem>
                    <SelectItem value="sequential">По приоритету</SelectItem>
                  </SelectContent>
                </Select>
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Anthropic upstream base URL"
                description="QA override for Anthropic traffic."
                error={configErrors.anthropicUpstreamBaseUrl}
              >
                <Input
                  aria-label="Anthropic upstream base URL"
                  aria-invalid={
                    configErrors.anthropicUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.anthropicUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "anthropicUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() =>
                    void saveConfigField("anthropicUpstreamBaseUrl")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Codex upstream base URL"
                description="QA override for ChatGPT Codex traffic."
                error={configErrors.codexUpstreamBaseUrl}
              >
                <Input
                  aria-label="Codex upstream base URL"
                  aria-invalid={
                    configErrors.codexUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.codexUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "codexUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Quota switch threshold"
                description="Prefer accounts below this quota fraction. Accounts above it still serve while the provider accepts them."
                error={configErrors.switchThreshold}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  aria-label="Quota switch threshold"
                  aria-invalid={
                    configErrors.switchThreshold === null ? undefined : true
                  }
                  disabled={config === null || configSaving}
                  value={drafts.switchThreshold}
                  onChange={(event) =>
                    updateConfigDraft("switchThreshold", event.target.value)
                  }
                  onBlur={() => void saveConfigField("switchThreshold")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <div className="flex items-start justify-between gap-4">
                <div className="py-2.5">
                  <div className="text-sm text-foreground">Machine tokens</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {hubHosts}
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 py-2.5">
                  {status?.hosts.map((host) => (
                    <Button
                      key={host.hostId}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void run(`rotate-${host.hostId}`, async () => {
                          await rpc.call("token.rotate", {
                            machine: host.hostId,
                          });
                        })
                      }
                    >
                      Rotate {host.hostName ?? host.hostId}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        {dialog?.kind === "account" && selectedAccount !== null ? (
          <AccountDialog
            account={selectedAccount}
            threshold={threshold}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Set priority"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) ||
                    pending.has(`priority-${selectedAccount.id}`)
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDialog(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first in the failover order. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "proxy" && selectedAccount !== null ? (
          <DialogFrame
            title="Set proxy"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    pending.has(`proxy-${selectedAccount.id}`) ||
                    (selectedAccount.proxy === null &&
                      !selectedAccount.proxyUnreadable)
                  }
                  onClick={() => saveProxy(selectedAccount.id, null)}
                >
                  Remove proxy
                </Button>
                <Button
                  disabled={
                    !proxyFieldsSchema.safeParse(fields).success ||
                    pending.has(`proxy-${selectedAccount.id}`)
                  }
                  onClick={() =>
                    void run(`proxy-${selectedAccount.id}`, async () => {
                      await rpc.call("account.saveProxyFields", {
                        id: selectedAccount.id,
                        fields,
                      });
                      closeDialog();
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <ProxyInput fields={fields} change={editProxy} />
            <ProxyCheck
              key={`${selectedAccount.id}:${proxyRevision}`}
              account={selectedAccount}
              draft={fields}
            />
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogFrame>
        ) : null}
        {dialog?.kind === "new-login" ? (
          <DialogFrame
            title={
              dialog.provider === "claude"
                ? "Sign in to Claude"
                : "Sign in to Codex"
            }
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (invalidNewProxy) {
                      setError(
                        "Enter a valid proxy URL with http://, https:// or socks5://.",
                      );
                      return;
                    }
                    void startLogin(dialog.provider, {
                      ...NEW_LOGIN,
                      ...(proxy.length === 0 ? {} : { proxy }),
                    });
                    setFields(initialProxy());
                  }}
                >
                  Continue
                </Button>
              </>
            }
          >
            <StepIndicator step={1} />
            <ProxyInput fields={fields} change={editProxy} />
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogFrame>
        ) : null}
        {dialog?.kind === "api-key" ? (
          <DialogFrame
            title="Add an Anthropic API key"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    invalidNewProxy ||
                    apiKey.trim().length === 0 ||
                    pending.has("api-key")
                  }
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: "claude",
                        apiKey: apiKey.trim(),
                        ...(proxy.length === 0 ? {} : { proxy }),
                        label: null,
                        priority: 100,
                      });
                      setApiKey("");
                      closeDialog();
                    })
                  }
                >
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Metered fallback stored in the Account Pooler&apos;s protected
              secret directory.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label="Anthropic API key"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <ProxyInput fields={fields} change={editProxy} />
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Remove ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending.has(`remove-${selectedAccount.id}`)}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              This deletes the account&apos;s secret file. Threads fall back to
              their machine login when no other pooled account is available.
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "claude-login" ? (
          <LoginDialog
            provider="claude"
            relogin={reloginAccount}
            loginStep={loginStep}
            codexStep={null}
            loginDone={loginDone}
            pending={
              pending.has("claude-login") || pending.has("complete-claude")
            }
            pastedCode={pastedCode}
            countdown={0}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={setPastedCode}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc.call("login.complete", {
                  sessionId: loginStep.sessionId,
                  pasted: pastedCode,
                });
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            restart={() => void startClaude(dialog.target)}
            addAnother={() => chooseAdd("claude", "login")}
          />
        ) : null}
        {dialog?.kind === "codex-login" ? (
          <LoginDialog
            provider="codex"
            relogin={reloginAccount}
            loginStep={null}
            codexStep={codexStep}
            loginDone={loginDone}
            pending={pending.has("codex-login")}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            restart={() => void startCodex(dialog.target)}
            addAnother={() => chooseAdd("codex", "login")}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function AccountDialog({
  account,
  threshold,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  act: (action: "toggle" | "refresh" | "relogin" | "remove") => void;
}) {
  const windows = displayWindows(account);
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  return (
    <DialogFrame
      title={account.label}
      className="sm:max-w-xl"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={() => act("toggle")}>
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Refresh usage
          </Button>
          {account.kind === "oauth" ? (
            <Button size="sm" variant="outline" onClick={() => act("relogin")}>
              Sign in again
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>{statusPresentation(account).label}</SettingsBadge>
      </div>
      <div className="space-y-4">
        {windows.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No usage limits observed yet.
          </div>
        ) : (
          windows.map((window) => (
            <QuotaDetail
              key={window.key}
              label={window.long}
              quota={window.quota}
              threshold={threshold}
            />
          ))
        )}
        {modelFamilySchema.options.flatMap((family) =>
          account.familyWeekly[family] === null
            ? []
            : [
                <QuotaDetail
                  key={family}
                  label={FAMILY_LABELS[family]}
                  quota={account.familyWeekly[family]}
                  threshold={threshold}
                />,
              ],
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Proxy</dt>
        <dd
          className={cn(
            "break-all",
            account.proxyUnreadable && "text-destructive",
          )}
        >
          {account.proxyUnreadable
            ? "unreadable"
            : account.proxy === null
              ? "—"
              : `${account.proxy.scheme}://${account.proxy.host}`}
        </dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DialogFrame>
  );
}

function LoginError({
  message,
  restart,
}: {
  message: string;
  restart: () => void;
}) {
  return (
    <p className="text-sm text-destructive-text">
      {message.replace(/\s*Start again\.$/u, "")}{" "}
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 align-baseline text-sm text-foreground underline underline-offset-4"
        onClick={restart}
      >
        Start again
      </Button>
    </p>
  );
}

function LoginDialog({
  provider,
  relogin,
  loginStep,
  codexStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  setPastedCode,
  complete,
  restart,
  addAnother,
}: {
  provider: PoolProvider;
  relogin: AccountSummary | null;
  loginStep: OAuthLoginStart | null;
  codexStep: CodexDeviceLoginStart | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  setPastedCode: (value: string) => void;
  complete: () => void;
  restart: () => void;
  addAnother: () => void;
}) {
  const name = provider === "claude" ? "Claude" : "Codex";
  const url =
    provider === "claude"
      ? loginStep?.authorizeUrl
      : codexStep?.verificationUri;
  return (
    <DialogFrame
      title={
        relogin === null
          ? `Sign in to ${name}`
          : `Sign in again to ${relogin.label}`
      }
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            {relogin === null ? (
              <Button variant="outline" onClick={addAnother}>
                Add another
              </Button>
            ) : null}
            <Button onClick={close}>Done</Button>
          </>
        ) : provider === "claude" ? (
          <>
            <span className="flex-1" />
            <Button
              disabled={
                loginStep === null ||
                pastedCode.trim().length === 0 ||
                pending ||
                error !== null
              }
              onClick={complete}
            >
              Complete
            </Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        relogin === null ? (
          <div>
            <h3 className="text-base font-semibold">Connected {loginDone}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {name} threads on every machine now route through this account.
              Usage refreshes in the background.
            </p>
          </div>
        ) : (
          <div>
            <h3 className="text-base font-semibold">
              Signed in again to {loginDone}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Its priority, enabled state, and pinned conversations are
              unchanged.
            </p>
          </div>
        )
      ) : url === undefined ? (
        error !== null ? (
          <LoginError message={error} restart={restart} />
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {relogin === null
              ? null
              : `Sign in as ${relogin.email ?? relogin.label}. `}
            {provider === "claude"
              ? "Sign in at claude.ai, then paste the code from the final page."
              : "Open the verification page, sign in to ChatGPT, and enter this code."}
          </p>
          {codexStep === null ? null : (
            <UserCodeBlock userCode={codexStep.userCode} />
          )}
          <AuthorizationUrlRow name={name} url={url} openUrl={openUrl} />
          {provider === "claude" ? (
            <>
              <Input
                aria-label="Claude authorization code"
                placeholder="Paste code#state here"
                value={pastedCode}
                onChange={(event) => setPastedCode(event.target.value)}
              />
              {error === null ? null : (
                <LoginError message={error} restart={restart} />
              )}
            </>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DialogFrame>
  );
}

function AccountChoice({ threadId }: { threadId: string | null }) {
  const composer = useComposer();
  const sdk = useSdk();
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [originalProvider, setOriginalProvider] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      rpc.call("status.get", null),
      threadId ? rpc.call("thread.choice", { threadId }) : null,
      threadId ? sdk.threads.get({ threadId }) : null,
    ])
      .then(([pool, saved, thread]) => {
        if (!active) return;
        setStatus(pool);
        setChoice(saved);
        setOriginalProvider(thread?.providerId ?? null);
        setBusy(false);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [rpc, sdk, threadId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  const providerId = (account: AccountSummary) =>
    agentProviderId(account.provider);
  const selected = status?.accounts.find((a) => a.id === choice);
  const switchThread = Boolean(
    threadId && selected && providerId(selected) !== originalProvider,
  );
  const locked = busy || composer.isRunning;
  async function choose(account: AccountSummary | null) {
    if (threadId && (!account || providerId(account) === originalProvider)) {
      if (account && composer.selection?.providerId !== originalProvider) {
        const settled = await composer.setSelection({
          providerId: providerId(account),
        });
        if (settled.providerId !== originalProvider)
          throw new Error("Провайдер недоступен на этой машине.");
      }
      await rpc.call("thread.choose", {
        threadId,
        accountId: account?.id ?? null,
      });
      composer.experimental_closePopup();
    }
    setChoice(account?.id ?? null);
  }
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1 p-1.5"
      aria-label="Выбор аккаунта"
    >
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        disabled={locked}
        aria-pressed={choice === null}
        onClick={() => void run(() => choose(null))}
      >
        <Icon name="Layers" />
        Авто
        {choice === null && (
          <Icon name="Check" className="ml-auto text-primary" />
        )}
      </Button>
      {Array.from(
        new Set(status?.accounts.map((account) => account.provider)),
      ).map((provider) => {
        const accounts =
          status?.accounts.filter((a) => a.provider === provider) ?? [];
        if (!accounts.length || !status) return null;
        const routed = status.routing[provider];
        return (
          <section key={provider} className="border-t pt-1">
            <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
              <ProviderLabel provider={provider} />
              {!routed && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  onClick={() =>
                    void run(async () => {
                      await rpc.call("routing.set", {
                        provider,
                        enabled: true,
                      });
                      setStatus(await rpc.call("status.get", null));
                    })
                  }
                >
                  Включить пул
                </Button>
              )}
            </div>
            {accounts.map((a) => {
              const weekly = a.limitWindows.find(
                (w) => w.windowMinutes === 10080,
              )?.utilization;
              return (
                <div className="flex min-w-0 items-center" key={a.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-0 flex-1 justify-start gap-2"
                    disabled={locked || !a.enabled || !routed}
                    aria-pressed={choice === a.id}
                    onClick={() => void run(() => choose(a))}
                  >
                    <Icon name="UserRound" />
                    <span className="truncate">{a.label}</span>
                    {a.proxy && (
                      <ProxyCountryFlag
                        key={a.proxy.scheme + a.proxy.host}
                        id={a.id}
                      />
                    )}
                    {weekly != null && (
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {Math.round(weekly * 100)}%
                      </span>
                    )}
                    {choice === a.id && (
                      <Icon name="Check" className="text-primary" />
                    )}
                  </Button>
                  {!a.enabled && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={locked}
                      aria-label={`Включить аккаунт ${a.label}`}
                      onClick={() =>
                        void run(async () => {
                          await rpc.call("account.enable", { id: a.id });
                          setStatus(await rpc.call("status.get", null));
                        })
                      }
                    >
                      Включить
                    </Button>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {(threadId === null || switchThread) && (
        <div className="flex flex-col gap-2 border-t p-2">
          {switchThread && (
            <p className="text-xs text-muted-foreground">
              BB продолжит разговор в новом чате выбранного провайдера.
            </p>
          )}
          <Button
            size="sm"
            disabled={
              locked ||
              composer.isSubmittingBlocked ||
              (choice !== null && !selected?.enabled)
            }
            onClick={() =>
              void run(async () => {
                if (
                  selected &&
                  composer.selection?.providerId !== providerId(selected)
                ) {
                  const settled = await composer.setSelection({
                    providerId: providerId(selected),
                  });
                  if (
                    settled.providerId !== providerId(selected) ||
                    !settled.model
                  )
                    throw new Error(
                      "Для этого провайдера нет доступной модели.",
                    );
                }
                await composer.submit(
                  choice ? { experimental_data: { accountId: choice } } : {},
                );
                composer.experimental_closePopup();
              })
            }
          >
            {switchThread ? "Продолжить в новом чате" : "Отправить"}
          </Button>
        </div>
      )}
      {error && (
        <p className="px-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ComposerChoice() {
  const composer = useComposer();
  if (composer.scope.kind === "queued-message") return null;
  return (
    <AccountChoice
      key={composer.key}
      threadId={
        composer.scope.kind === "thread" ? composer.scope.threadId : null
      }
    />
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "codex-account",
    scopes: ["thread", "new-thread"],
    experimental_popups: [
      {
        id: "account-choice",
        label: "Аккаунт",
        component: ComposerChoice,
      },
    ],
    plusMenu: [
      {
        id: "choose",
        label: "Аккаунт",

        run: ({ composer }) => {
          composer.experimental_openPopup("account-choice");
        },
      },
    ],
  });
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});

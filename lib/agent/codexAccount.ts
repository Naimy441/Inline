import { connectCodex, type CodexConnection } from "./codexRpc";
import type { AgentStatus, Effort, ModelOption, PlanUsage, UsageWindow } from "./types";
import type { LoginState } from "@/lib/server/claudeLogin";

type Quota = { limitId?: string | null; limitName?: string | null; planType?: string | null; primary?: Window | null; secondary?: Window | null };
type Window = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };
export type CodexLimits = { rateLimits?: Quota | null; rateLimitsByLimitId?: Record<string, Quota> | null };

/** Keep each quota bucket; do not mistake usedPercent for remaining usage or missing data for zero. */
export function codexPlanUsage(answer: CodexLimits, now = Date.now()): PlanUsage {
  const buckets = Object.entries(answer.rateLimitsByLimitId ?? {});
  if (!buckets.length && answer.rateLimits) buckets.push([answer.rateLimits.limitId ?? "codex", answer.rateLimits]);
  const windows: UsageWindow[] = [];
  for (const [id, quota] of buckets) for (const slot of ["primary", "secondary"] as const) {
    const window = quota[slot];
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const duration = window.windowDurationMins;
    const label = duration === 300 ? "Session" : duration === 10080 ? "Weekly" : duration ? `${duration >= 60 ? `${duration / 60} hr` : `${duration} min`} window` : slot === "primary" ? "Session" : "Weekly";
    windows.push({ id: `codex:${id}:${slot}`, label: `${quota.limitName ?? id} · ${label}`, utilization: window.usedPercent, resetsAt: window.resetsAt ? window.resetsAt * 1000 : null });
  }
  const plan = buckets[0]?.[1].planType ?? null;
  return windows.length ? { available: true, plan, windows, checkedAt: now } : { available: false, plan, checkedAt: now };
}

class CodexAccount {
  private status: AgentStatus | null = null;
  private statusPending: Promise<AgentStatus> | null = null;
  private usage: PlanUsage | null = null;
  private limits: CodexLimits = {};
  private usagePending: Promise<PlanUsage> | null = null;
  private login: LoginState = { state: "idle" };
  private loginRpc: CodexConnection | null = null;
  private loginId: string | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private loginAttempt = 0;

  async agentStatus(force = false): Promise<AgentStatus> {
    if (!force && this.status && Date.now() - this.status.checkedAt < (this.status.state === "ready" ? 300_000 : 10_000)) return this.status;
    if (!this.statusPending) this.statusPending = this.probe().then((status) => this.status = status).finally(() => { this.statusPending = null; });
    return this.statusPending;
  }
  private async probe(): Promise<AgentStatus> {
    let rpc: CodexConnection | undefined;
    try {
      rpc = await connectCodex();
      const { account, requiresOpenaiAuth } = await rpc.request("account/read", { refreshToken: false });
      if (!account && requiresOpenaiAuth !== false) return { state: "signed_out", message: "Sign in to Codex with your ChatGPT account.", checkedAt: Date.now() };
      const models: ModelOption[] = [];
      let cursor: string | null = null;
      let defaultModel: string | null = null;
      do {
        const page: { data: any[]; nextCursor: string | null } = await rpc.request("model/list", { cursor, limit: 100 });
        for (const model of page.data ?? []) {
          if (model.hidden) continue;
          const value = model.model ?? model.id;
          models.push({ value, displayName: model.displayName, description: model.description ?? "", efforts: (model.supportedReasoningEfforts ?? []).map((option: { reasoningEffort: string }) => option.reasoningEffort as Effort), provider: "codex" });
          if (model.isDefault) defaultModel = value;
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return { state: "ready", account: { email: account?.email ?? undefined, plan: account?.planType, provider: "codex" }, models, defaultModel: defaultModel ?? models[0]?.value ?? null, checkedAt: Date.now() };
    } catch (error) { return { state: "unavailable", message: error instanceof Error ? error.message : "Codex isn't available.", checkedAt: Date.now() }; }
    finally { rpc?.close(); }
  }
  noteUsage(answer: CodexLimits) { this.limits = answer; this.usage = codexPlanUsage(answer); return this.usage; }
  noteRateLimit(quota: Quota) {
    const id = quota.limitId ?? "codex";
    const buckets = { ...this.limits.rateLimitsByLimitId };
    if (!Object.keys(buckets).length && this.limits.rateLimits) buckets[this.limits.rateLimits.limitId ?? "codex"] = this.limits.rateLimits;
    const previous = buckets[id] ?? {};
    buckets[id] = { ...previous, ...Object.fromEntries(Object.entries(quota).filter(([, value]) => value != null)) };
    return this.noteUsage({ ...this.limits, rateLimitsByLimitId: buckets });
  }
  async planUsage(force = false): Promise<PlanUsage> {
    if (!force && this.usage && Date.now() - this.usage.checkedAt < 60_000) return this.usage;
    if (!this.usagePending) this.usagePending = (async () => {
      const rpc = await connectCodex();
      try { return this.noteUsage(await rpc.request("account/rateLimits/read")); }
      finally { rpc.close(); }
    })().finally(() => { this.usagePending = null; });
    return this.usagePending;
  }
  loginStatus() { return this.login; }
  async startLogin() {
    if (this.loginRpc || this.login.state === "waiting") return this.login;
    const attempt = ++this.loginAttempt;
    this.login = { state: "waiting", url: null, startedAt: Date.now() };
    try {
      const rpc = await connectCodex();
      if (attempt !== this.loginAttempt) { rpc.close(); return this.login; }
      this.loginRpc = rpc;
      rpc.onMessage((message) => {
        if (message.method !== "account/login/completed" || message.params?.loginId !== this.loginId) return;
        this.login = message.params.success ? { state: "done" } : { state: "failed", message: message.params.error ?? "Codex sign-in failed." };
        this.status = null;
        this.usage = null;
        this.releaseLogin();
      });
      rpc.onClose((error) => { if (this.loginRpc === rpc) { this.login = { state: "failed", message: error.message }; this.releaseLogin(); } });
      const result = await rpc.request("account/login/start", { type: "chatgpt" });
      if (attempt !== this.loginAttempt) { rpc.close(); return this.login; }
      this.loginId = result.loginId;
      this.login = { state: "waiting", url: result.authUrl, startedAt: Date.now() };
      this.loginTimer = setTimeout(() => { this.login = { state: "failed", message: "Sign-in timed out. Try again." }; this.releaseLogin(); }, 10 * 60_000);
      this.loginTimer.unref?.();
    } catch (error) { this.login = { state: "failed", message: String(error) }; this.releaseLogin(); }
    return this.login;
  }
  async cancelLogin() {
    this.loginAttempt += 1;
    if (this.loginRpc && this.loginId) await this.loginRpc.request("account/login/cancel", { loginId: this.loginId }).catch(() => undefined);
    this.releaseLogin();
    this.login = { state: "idle" };
    return this.login;
  }
  private releaseLogin() {
    const rpc = this.loginRpc;
    this.loginRpc = null;
    this.loginId = null;
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    rpc?.close();
  }
}

const KEY = Symbol.for("inline.codexAccount");
export function codexAccount(): CodexAccount {
  const globals = globalThis as unknown as Record<symbol, CodexAccount>;
  return globals[KEY] ??= new CodexAccount();
}

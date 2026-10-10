// In-memory push sender for tests: records every push, answers what the test scripts.
import type { PushMessage, PushOutcome, PushSender, PushTarget } from "../push.ts";
import { DEFAULT_PUSH_HOSTS } from "../config.ts";

export class FakePush implements PushSender {
  readonly apns = true;
  readonly webPublicKey: string | null = "B".padEnd(87, "A");
  readonly allowedHosts = DEFAULT_PUSH_HOSTS;
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  /** address -> the outcome to answer (default: accepted). */
  readonly answers = new Map<string, PushOutcome>();

  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    this.sent.push({ target, message });
    return this.answers.get(target.address) ?? { ok: true, status: target.kind === "apns" ? 200 : 201, ...(target.kind === "apns" ? { environment: target.environment ?? "production" } : {}) };
  }

  /** The pushes that went to one address. */
  to(address: string): PushMessage[] {
    return this.sent.filter((s) => s.target.address === address).map((s) => s.message);
  }
}

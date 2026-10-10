// instance.set_budget: change the instance's monthly machine budget (a Tier 3 change: it is the
// instance's own spend guard). Only the owner approves it, with a passkey. The new value is kept
// in the instance state and overrides `budget.monthlyUsd` from the config until changed again.
import type { ActionType } from "./index.ts";
import { httpError } from "../errors.ts";
import { budgetCapUsd, setBudgetOverride } from "../spend.ts";

const fmt = (v: number | null) => (v === null ? "no cap" : `USD ${v.toFixed(2)} a month`);

export const setBudget: ActionType = {
  type: "instance.set_budget",
  tier: 3,
  params: {
    monthlyUsd: { type: "number|null", required: true, description: "the new monthly machine budget in USD (0..100000), or null for no cap" },
  },
  validate(p) {
    const v = p.monthlyUsd;
    if (v === null) return { monthlyUsd: null };
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw httpError("bad_request", "monthlyUsd must be a number 0..100000 or null");
    return { monthlyUsd: Math.round(v * 100) / 100 };
  },
  preview(p, _config, ctx) {
    const now = budgetCapUsd(ctx);
    const next = p.monthlyUsd as number | null;
    return {
      summary: `Change the instance's monthly machine budget from ${fmt(now)} to ${fmt(next)}`,
      fields: [
        { label: "Instance", value: ctx.config.instanceName },
        { label: "Now", value: fmt(now) },
        { label: "New", value: fmt(next) },
      ],
      body: null,
    };
  },
  async run({ ctx, params }) {
    const before = budgetCapUsd(ctx);
    setBudgetOverride(ctx, params.monthlyUsd as number | null);
    return { before, after: budgetCapUsd(ctx) };
  },
};

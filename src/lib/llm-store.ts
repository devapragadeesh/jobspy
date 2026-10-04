import { db } from "./db";
import { configureLlm, type LlmStore } from "./llm";

const supabaseStore: LlmStore = {
  async load() {
    const { data, error } = await db().from("llm_state").select("model, exhausted_until");
    if (error) throw new Error(error.message);
    return Object.fromEntries((data ?? []).map((row) => [row.model, row.exhausted_until]));
  },
  async save(model, exhaustedUntil) {
    const { error } = await db().from("llm_state").upsert({ model, exhausted_until: exhaustedUntil.toISOString() });
    if (error) throw new Error(error.message);
  },
};

/** Share exhausted-model state between scanner runs and the web UI through the database. */
export function rememberQuotaInDatabase(): void {
  configureLlm({ store: supabaseStore });
}

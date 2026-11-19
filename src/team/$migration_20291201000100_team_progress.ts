/** Estimate and self-reported progress (latest values) on team.task; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS estimate_min integer;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS estimate_steps integer;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS estimated_at bigint;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS progress_percent integer;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS progress_stage text;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS progress_eta_min integer;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS progress_note text;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS progress_at bigint;
`});
 }
};

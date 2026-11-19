/** Dynamic roster: member passport and departure fields, cancelled deliveries for departed members; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.member ADD COLUMN IF NOT EXISTS persona jsonb;
ALTER TABLE team.member ADD COLUMN IF NOT EXISTS joined_at bigint;
ALTER TABLE team.member ADD COLUMN IF NOT EXISTS left_at bigint;
ALTER TABLE team.member ADD COLUMN IF NOT EXISTS left_reason text;
ALTER TABLE team.member ADD COLUMN IF NOT EXISTS hired_by text;
ALTER TABLE team.delivery DROP CONSTRAINT IF EXISTS delivery_status_check;
ALTER TABLE team.delivery ADD CONSTRAINT delivery_status_check CHECK(status IN ('pending','claimed','delivered','failed','cancelled'));
`});
 }
};

/** Agent acting for its person: team.event, team.command and team.persona_rev record on_behalf_of (the owner user id) next to actor_kind='agent'; null for the person's own calls; additive and idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.event ADD COLUMN IF NOT EXISTS on_behalf_of text;
ALTER TABLE team.command ADD COLUMN IF NOT EXISTS on_behalf_of text;
ALTER TABLE team.persona_rev ADD COLUMN IF NOT EXISTS on_behalf_of text;
`});
 }
};

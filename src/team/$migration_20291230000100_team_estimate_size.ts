/** Task size estimate S|M|L on team.task (replaces minutes; old estimate_min stays and is mapped to a size on read); idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS estimate_size text;
`});
 }
};

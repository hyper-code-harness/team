/**
 * Writes a short note into the shared team feed shown in the board timeline
 *
 * Use when you found something important for others, changed a shared file, got stuck, asked something or finished a big step — not for every small action. One note is at most 280 characters, plain text. The author is the calling agent (or the signed-in person). The note appears in the «Хроника» of team.dashboard with a sign by kind; a taskId links it to the task card. Refreshes the live 'team' topic.
 * @param opts.text The note itself, up to 280 characters.
 * @param opts.taskId Related task id (team task or own plan task).
 * @param opts.kind note (default), heads-up (others should know), question, done (finished a big step).
 * @param opts.teamId Team id when the note belongs to a team-plugin team.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** The note itself, up to 280 characters. */
        text: string;
        /** Related task id (team task or own plan task). */
        taskId?: string;
        /** note (default), heads-up (others should know), question, done (finished a big step). */
        kind?: 'note' | 'heads-up' | 'question' | 'done';
        /** Team id when the note belongs to a team-plugin team. */
        teamId?: string;
    },
): Promise<{ id: string; kind: string; text: string; authorId: string; taskId: string | null; at: number }> {
    const text = String(opts.text ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('team.post: text is empty');
    if (text.length > 280) throw new Error('team.post: text is longer than 280 characters (' + text.length + ')');
    const kind = opts.kind ?? 'note';
    if (!['note', 'heads-up', 'question', 'done'].includes(kind)) throw new Error('team.post: kind must be note, heads-up, question or done');
    const actor = await ctx.fns.team.resolveActor({});
    const id = Bun.randomUUIDv7(); const at = Date.now();
    const taskId = opts.taskId?.trim() || null; const teamId = opts.teamId?.trim() || null;
    // Self-heal when the migration has not run yet (same DDL as $migration_20291210000100_team_post).
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.post (id text PRIMARY KEY, author_kind text NOT NULL, author_id text NOT NULL, team_id text, task_id text, kind text NOT NULL DEFAULT 'note', text text NOT NULL, created_at bigint NOT NULL)" });
    await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params: [id, actor.kind, actor.id, teamId, taskId, kind, text, at] });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { id, kind, text, authorId: actor.id, taskId, at };
}

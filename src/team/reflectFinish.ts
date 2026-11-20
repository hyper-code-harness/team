/**
 * Finish a pending team.reflect: post what the persona changed in its memory after the owner's feedback
 *
 * Runs from the cron task team-reflect:<inboxId> that team.reflect registers; every argument except inboxId is read from that task row. When the session wrote a memo or prompt revision after the feedback was sent: removes the cron task, marks the inbox row reflected and writes one team.post note «<persona> вывод по отзыву: <diff>». Session archived or the deadline passed without a revision: the feedback goes back to the queue (status queued) so the next brief of the persona asks for it. Otherwise waits for the next tick. No pending reflect: status 'none'.
 * @param opts.inboxId team.feedback_inbox id whose reflect is pending.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** team.feedback_inbox id whose reflect is pending. */
        inboxId: string;
    },
): Promise<{ inboxId: string; status: 'none' | 'waiting' | 'reflected' | 'queued'; summary: string }> {
    type Row = Record<string, any>;
    const inboxId = String(opts.inboxId ?? '').trim();
    const task = 'team-reflect:' + inboxId;
    const t = (await ctx.fns.procs.db.select({ sql: 'SELECT args FROM cron_tasks WHERE name = ? AND enabled', params: [task] }) as Row[])[0];
    if (!inboxId || !t) return { inboxId, status: 'none', summary: '' };
    const a: Row = (typeof t.args === 'string' ? JSON.parse(t.args) : t.args) ?? {};
    const agentId = String(a.agentId ?? ''), persona = String(a.persona ?? ''), startedAt = Number(a.startedAt ?? 0), deadlineAt = Number(a.deadlineAt ?? 0);
    const revs = await ctx.fns.procs.db.select({ sql: "SELECT field, path, summary FROM team.persona_rev WHERE persona_name = ? AND author_kind = 'agent' AND author_id = ? AND at >= ? AND field IN ('memo','prompt') ORDER BY at", params: [persona, agentId, startedAt] }) as Row[];
    const ag = (await ctx.fns.procs.db.select({ sql: 'SELECT run_state, archived_at FROM agents WHERE id = ?', params: [agentId] }) as Row[])[0];
    const now = Date.now();
    const gone = !ag || ag.archived_at != null;
    if (!revs.length && !gone && now < deadlineAt) return { inboxId, status: 'waiting', summary: '' };
    // only the caller that removes the cron row finishes (cron tick and a manual call can race)
    const claimed = await ctx.fns.procs.db.select({ sql: 'DELETE FROM cron_tasks WHERE name = ? RETURNING name', params: [task] }) as Row[];
    if (!claimed.length) return { inboxId, status: 'none', summary: '' };
    if (!revs.length) {
        await ctx.fns.procs.db.run({ sql: "UPDATE team.feedback_inbox SET status = 'queued', to_agent_id = NULL WHERE id = ? AND status = 'sent'", params: [inboxId] });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { inboxId, status: 'queued', summary: '' };
    }
    await ctx.fns.procs.db.run({ sql: "UPDATE team.feedback_inbox SET status = 'reflected', reflected_at = ? WHERE id = ?", params: [now, inboxId] });
    const row = (await ctx.fns.procs.db.select({ sql: 'SELECT title, task_id, ref_agent_id, kind, stars FROM team.feedback_inbox WHERE id = ?', params: [inboxId] }) as Row[])[0] ?? {};
    const diff = [...new Set(revs.map(r => String(r.summary ?? '').trim() || (r.field === 'memo' ? 'мемо ' + String(r.path ?? '') : String(r.field))))].join('; ');
    const what = row.kind === 'rating' ? 'оценке ★' + row.stars : 'комментарию';
    const text = `${persona} вывод по ${what} «${String(row.title ?? '').slice(0, 60)}»: ${diff}`.replace(/\s+/g, ' ').slice(0, 280);
    try {
        const teamRow = (await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.persona_session WHERE agent_id = ?', params: [agentId] }) as Row[])[0];
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, 'agent', ?, ?, ?, 'note', ?, ?)", params: [Bun.randomUUIDv7(), agentId, teamRow?.team_id ?? null, row.ref_agent_id ? null : (row.task_id ?? null), text, now] });
    } catch {}
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { inboxId, status: 'reflected', summary: text };
}

/**
 * Answer a colleague's question (team.ask) once: the answer goes back to the asker as an agent message and to the chronicle
 *
 * Call from the session that got «Вопрос от … (askId …)». Only the session the question was sent to may answer, and only once (one question — one answer; a second call returns status 'already'). The asker gets an agent message «Ответ <name> на твой вопрос …» without waking a reply chain: the asker must not answer the answer. The chronicle gets «<name> ответил(а): …».
 * @param opts.askId Question id from the message.
 * @param opts.text The answer, up to 4000 characters.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Question id from the message. */
        askId: string;
        /** The answer, up to 4000 characters. */
        text: string;
    },
): Promise<{ askId: string; status: 'answered' | 'already'; to: string }> {
    type Row = Record<string, any>;
    const db = ctx.fns.procs.db;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'agent') throw new Error('team.answer: call from the agent session the question was sent to');
    const askId = String(opts.askId ?? '').trim();
    const text = String(opts.text ?? '').replace(/\u0000/g, '').trim();
    if (!askId) throw new Error('team.answer: askId required');
    if (!text) throw new Error('team.answer: text is empty');
    if (text.length > 4000) throw new Error('team.answer: text longer than 4000 characters');
    const q = (await db.select({ sql: 'SELECT * FROM team.ask WHERE id=?', params: [askId] }) as Row[])[0];
    if (!q) throw new Error('team.answer: no question ' + askId);
    if (String(q.to_agent_id ?? '') !== actor.id) throw new Error('team.answer: this question was sent to another session');
    const upd = await db.select({ sql: "UPDATE team.ask SET status='answered', answer=?, answered_by=?, answered_at=? WHERE id=? AND status='asked' RETURNING id", params: [text, actor.id, Date.now(), askId] }) as Row[];
    if (!upd.length) return { askId, status: 'already', to: String(q.from_agent_id) };
    const name = String(q.to_persona);
    const cut = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? f.slice(0, n - 1) + '…' : f; };
    const me = (session as any)?.agent?.id === actor.id ? (session as any).agent : ((ctx.state as any)?.agent?.[actor.id] ?? await ctx.fns.session.load({ id: actor.id }));
    const body = `Ответ ${name} на твой вопрос${q.task_title ? ` по задаче «${q.task_title}»` : ''} (askId ${askId}):\n\n${text}\n\n(Это ответ на team.ask — отвечать на него не нужно.)`;
    await ctx.fns.agent.message({ agent: me, to: String(q.from_agent_id), text: body });
    try { await ctx.fns.team.post({ text: cut(`${name} ответил(а) ${q.from_name}: ${text}`, 280), kind: 'note', ...(q.task_id ? { taskId: String(q.task_id) } : {}) }); } catch {}
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { askId, status: 'answered', to: String(q.from_agent_id) };
}

/**
 * Hand the owner's rating or comment of a finished task to the executor persona so it draws conclusions into its memory
 *
 * Called by team.rate (kind rating) and team.feedback on an accepted task (kind comment); owner (signed-in person) only. Finds the persona of the assignee session (team.persona_session / persona.current_agent_id). Not a persona: nothing happens (status 'none'). One inbox row per persona, kind, task (team.feedback_inbox); the same stars and comment again → status 'duplicate', nothing is sent or posted. Live session (persona.current_agent_id, else the assignee: not archived, no pending team.retire) → a notification «Оценка niquola: ★N … сделай вывод, запиши в мемо, при необходимости поправь промпт», a chronicle note «рефлексирует по оценке» and a cron task team-reflect:<id> running team.reflectFinish every 15 s, which posts the memory diff when the session wrote it (or moves the feedback to the queue after the timeout). `decide` (team.rate on a still open task): the message goes to the assignee session and asks it to decide — comment asks for more work → team.rework; otherwise reflect into memory/prompt, then team.close (its last task closed → the session leaves). No live session → status 'queued': the next brief of the persona lists it first and asks to reflect it; the next hand-in with a memo marks it reflected.
 * @param opts.kind rating (stars, optional comment) or comment (owner comment on an accepted task).
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task; '' or absent for a team task.
 * @param opts.assigneeAgentId Session that did the task.
 * @param opts.title Task title, shown to the persona.
 * @param opts.stars Rating 1–5 for kind rating. @minimum 1 @maximum 5
 * @param opts.comment Owner comment.
 * @param opts.timeoutSec How long a live session gets before the feedback goes to the brief queue. @default 600 @minimum 30 @maximum 3600
 * @param opts.decide kind rating only: the task is still open — the executor decides after reading: team.rework (comment asks for more) or reflect + team.close.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** rating (stars, optional comment) or comment (owner comment on an accepted task). */
        kind: 'rating' | 'comment';
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task; '' or absent for a team task. */
        agentId?: string;
        /** Session that did the task. */
        assigneeAgentId: string;
        /** Task title, shown to the persona. */
        title?: string;
        /** Rating 1–5 for kind rating. @minimum 1 @maximum 5 */
        stars?: number;
        /** Owner comment. */
        comment?: string;
        /** How long a live session gets before the feedback goes to the brief queue. @default 600 @minimum 30 @maximum 3600 */
        timeoutSec?: number;
        /** kind rating only: the task is still open — the executor decides after reading: team.rework (comment asks for more) or reflect + team.close. */
        decide?: boolean;
    },
): Promise<{ status: 'none' | 'duplicate' | 'sent' | 'queued'; persona: string | null; inboxId: string | null; to: string | null }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'user') throw new Error('team.reflect: owner feedback comes from the signed-in person');
    const kind = opts.kind === 'comment' ? 'comment' : 'rating';
    const taskId = String(opts.taskId ?? '').trim(); const refAgent = String(opts.agentId ?? '').trim();
    const assignee = String(opts.assigneeAgentId ?? '').trim();
    const stars = kind === 'rating' ? Number(opts.stars) : null;
    const comment = String(opts.comment ?? '').replace(/\u0000/g, '').trim().slice(0, 2000);
    const title = String(opts.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || taskId;
    const none = { status: 'none' as const, persona: null, inboxId: null, to: null };
    if (!taskId || !assignee) return none;
    const pr = (await ctx.fns.procs.db.select({ sql: 'SELECT name, current_agent_id FROM team.persona WHERE current_agent_id=? UNION ALL SELECT p.name, p.current_agent_id FROM team.persona_session s JOIN team.persona p ON p.name=s.persona_name WHERE s.agent_id=? LIMIT 1', params: [assignee, assignee] }).catch(() => []) as Row[])[0];
    if (!pr) return none;
    const persona = String(pr.name);
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.feedback_inbox (id text PRIMARY KEY, persona_name text NOT NULL, kind text NOT NULL, ref_agent_id text NOT NULL DEFAULT '', task_id text NOT NULL, title text NOT NULL DEFAULT '', stars integer, comment text NOT NULL DEFAULT '', sig text NOT NULL, status text NOT NULL, to_agent_id text, by_user text NOT NULL, created_at bigint NOT NULL, sent_at bigint, briefed_at bigint, reflected_at bigint, UNIQUE (persona_name, kind, ref_agent_id, task_id))" });
    const sig = (stars ?? '') + '|' + comment;
    const prev = (await ctx.fns.procs.db.select({ sql: 'SELECT id, sig FROM team.feedback_inbox WHERE persona_name=? AND kind=? AND ref_agent_id=? AND task_id=?', params: [persona, kind, refAgent, taskId] }) as Row[])[0];
    if (prev && String(prev.sig) === sig) return { status: 'duplicate', persona, inboxId: String(prev.id), to: null };
    const id = prev ? String(prev.id) : Bun.randomUUIDv7();
    const now = Date.now();

    // live target: the persona's current session first, else the session that did the task
    const alive = async (aid: string) => {
        if (!aid) return false;
        const a = (await ctx.fns.procs.db.select({ sql: 'SELECT archived_at FROM agents WHERE id=?', params: [aid] }).catch(() => []) as Row[])[0];
        if (!a || a.archived_at != null) return false;
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM cron_tasks WHERE name=? AND enabled', params: ['team-retire:' + aid] }).catch(() => []) as Row[];
        return !r.length;
    };
    const cur = String(pr.current_agent_id ?? '');
    // the task is still open: only its assignee can close or rework it, so the message goes to that session
    const decide = kind === 'rating' && !!opts.decide;
    const to = decide && await alive(assignee) ? assignee : (await alive(cur)) ? cur : (cur !== assignee && await alive(assignee)) ? assignee : '';
    const what = kind === 'rating' ? `Оценка ★${stars}${comment ? ', комментарий: ' + comment : ''}` : `Комментарий: ${comment}`;
    const status = to ? 'sent' : 'queued';
    await ctx.fns.procs.db.run({ sql: `INSERT INTO team.feedback_inbox (id, persona_name, kind, ref_agent_id, task_id, title, stars, comment, sig, status, to_agent_id, by_user, created_at, sent_at, briefed_at, reflected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
        ON CONFLICT (persona_name, kind, ref_agent_id, task_id) DO UPDATE SET title=EXCLUDED.title, stars=EXCLUDED.stars, comment=EXCLUDED.comment, sig=EXCLUDED.sig, status=EXCLUDED.status, to_agent_id=EXCLUDED.to_agent_id, by_user=EXCLUDED.by_user, created_at=EXCLUDED.created_at, sent_at=EXCLUDED.sent_at, briefed_at=NULL, reflected_at=NULL`,
        params: [id, persona, kind, refAgent, taskId, title, stars, comment, sig, status, to || null, actor.id, now, to ? now : null] });
    const post = async (author: string, text: string) => {
        try {
            const teamRow = (await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.persona_session WHERE agent_id = ?', params: [author] }).catch(() => []) as Row[])[0];
            await ctx.fns.procs.db.run({ sql: "INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, 'agent', ?, ?, ?, 'note', ?, ?)", params: [Bun.randomUUIDv7(), author, teamRow?.team_id ?? null, refAgent ? null : taskId, text.replace(/\s+/g, ' ').slice(0, 280), now] });
        } catch {}
    };
    const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    if (to) {
        const timeoutSec = Math.max(30, Math.min(3600, Math.floor(Number(opts.timeoutSec ?? 600))));
        const ref = `{ taskId: ${JSON.stringify(taskId)}${refAgent ? ', agentId: ' + JSON.stringify(refAgent) : ''} }`;
        const text = decide ? [
            `${what} — владелец оценил задачу «${title}» (${taskId}). Задача ещё открыта: решаешь ты.`,
            `1) Комментарий просит доделать или исправить? → team.rework(${ref}) — задача снова в работе у тебя; доделай, сдай заново (team.reportTask), владелец оценит ещё раз.`,
            `2) Иначе — рефлексия: сделай вывод (что повторять, чего избегать) и запиши в память — team.memoSave({ path, title, description, content | ops, reason: 'отзыв по ${taskId}' }) (user/feedback.md или тематическое мемо, ≤2500 символов); вывод о том, как тебе работать, — в промпт team.personaSave({ name: ${JSON.stringify(persona)}, field: 'prompt', ops, reason }) (раздел <!-- owner --> не трогай). Потом закрой: team.close(${ref}). Если это была твоя последняя задача, сессия после этого сама уйдёт в архив — больше ничего делать не нужно.`,
        ].join('\n') : [
            `${what} — по задаче «${title}» (${taskId}). Это отзыв владельца на твою сданную работу; задачу не переделывай.`,
            `Сделай вывод: что повторять, чего избегать. Запиши в память — team.memoSave({ path, title, description, content | ops, reason: 'отзыв по ${taskId}' }): user/feedback.md или тематическое мемо (одна тема — одно мемо, ≤2500 символов).`,
            `Если вывод про то, как тебе работать, — поправь промпт: team.personaSave({ name: ${JSON.stringify(persona)}, field: 'prompt', ops, reason }), раздел <!-- owner --> не трогай. Потом вернись к текущей работе.`,
        ].join('\n');
        await ctx.fns.session.enqueueNotification({ to, key: 'team-reflect:' + id + ':' + now, text, originalAuthor: actor.id });
        await post(to, `${persona} рефлексирует по ${kind === 'rating' ? 'оценке ★' + stars : 'комментарию'}: «${short(title, 80)}»${comment ? ' — ' + short(comment, 120) : ''}`);
        await ctx.fns.cron.add({ name: 'team-reflect:' + id, fn: 'team.reflectFinish', every: 15, args: { inboxId: id, agentId: to, persona, startedAt: now, deadlineAt: now + timeoutSec * 1000 } });
    } else {
        await post(assignee, `${persona}: ${kind === 'rating' ? 'оценка ★' + stars : 'комментарий'} по «${short(title, 80)}» в очереди — сессии нет, следующая отразит его в памяти первым делом`);
    }
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { status, persona, inboxId: id, to: to || null };
}

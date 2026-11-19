/**
 * Attach a structured report to one of the calling agent's own plan tasks
 *
 * For delegated children (agent.delegate plans). Persona sessions (team.persona_session / persona.current_agent_id) must leave memory: the hand-in is rejected unless the session created or updated at least one of the persona's memos since the task started (or was returned to work) — pass memo here (saved through team.memoSave first) or call team.memoSave/memoDelete before. Call before session.done for that task: stores {summary, done, decisions[{what,why}], checks, files, questions} on scratchpad.plan.tasks[taskId].report so the board card and team.taskView show it. Writes only the caller's own scratchpad; repeat to overwrite. When the plan task is linked to a team task (team.task_link, written by team.dispatch), the team task is also started if needed and submitted for review with this report (result.team). Team-plugin tasks put the same report into taskTransition submit instead.
 * @param opts.taskId Plan task id in the caller's own plan.
 * @param opts.report The report: summary required; done, decisions, checks, files, questions optional.
 * @param opts.memo Persona sessions: one memo to create or update with this hand-in (same fields as team.memoSave: path, title, description, content or ops, reason).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Plan task id in the caller's own plan. */
        taskId: string;
        /** The report: summary required; done, decisions, checks, files, questions optional. */
        report: types.team.TaskReport;
        /** Persona sessions: one memo to create or update with this hand-in (same fields as team.memoSave: path, title, description, content or ops, reason). */
        memo?: { path: string; title?: string; description?: string; content?: string; ops?: Array<{ op: 'add' | 'remove'; line: string; after?: string }>; reason?: string };
    },
): Promise<{agentId:string; taskId:string; status:string; report:Required<types.team.TaskReport>; team?:{teamId:string; taskId:string; status:string; eventId?:unknown; error?:string}; memo?:{path:string; changed:boolean; summary:string}}> {
    const self = (session as any)?.agent?.id ?? (await ctx.fns.agent.current({}))?.id;
        if (!self) throw new Error('reportTask: needs an agent session');
        const taskId = String(opts.taskId ?? '').trim();
        if (!taskId) throw new Error('reportTask: taskId required');
        const report = await ctx.fns.team.normalizeReport({ report: opts.report });
        // Persona session: no hand-in without a memo write since the task started.
        const persona = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [String(self), String(self)] })) as Array<Record<string, any>>)[0]?.name ?? '');
        let memo: { path: string; changed: boolean; summary: string } | undefined;
        if (persona) {
            if (opts.memo) {
                const m = await ctx.fns.team.memoSave({ name: persona, ...opts.memo, reason: opts.memo.reason ?? ('сдача ' + taskId) });
                memo = { path: m.path, changed: m.changed, summary: m.summary };
            }
            const sp = (session as any)?.agent?.id === self ? (session as any).agent.scratchpad : (await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad FROM agents WHERE id=?', params: [String(self)] }) as Array<Record<string, any>>)[0]?.scratchpad;
            const pad = typeof sp === 'string' ? JSON.parse(sp || '{}') : (sp ?? {});
            const pt = (pad?.plan?.tasks ?? []).find((t: any) => t?.id === taskId);
            const since = Math.max(Number(pt?.startedAt ?? 0), Number(pt?.reopenedAt ?? 0));
            const wrote = await ctx.fns.procs.db.select({ sql: "SELECT 1 FROM team.persona_rev WHERE persona_name=? AND field='memo' AND author_kind='agent' AND author_id=? AND at>=? LIMIT 1", params: [persona, String(self), since] });
            if (!wrote.length) throw new Error(`reportTask: ${persona}, сдать без записи в память нельзя. За эту задачу не создано и не обновлено ни одного мемо${memo ? ' (переданное memo ничего не изменило)' : ''}. Повтори вызов с memo: { path: 'code/<тема>.md', title, description, content | ops } — что следующей сессии нужно знать (файлы, ловушки, как проверял), или сначала вызови team.memoSave. Оглавление: team.memoSearch({}).`);
        }
        const at = Date.now();
        const out: any = await ctx.fns.session.mutateScratchpad({ id: String(self), mutate: (sp: Record<string, any>) => {
            const task = Array.isArray(sp?.plan?.tasks) ? sp.plan.tasks.find((t: any) => t?.id === taskId) : null;
            if (!task) throw new Error('reportTask: no plan task ' + taskId);
            task.report = { ...report, at };
            return { status: String(task.status ?? '') };
        } });
        const live = (session as any)?.agent;
        if (live && live.id === self) live.scratchpad = out.scratchpad;
        // A plan task linked to a team task (team.dispatch → team.task_link): hand the team task in for review.
        let team: { teamId: string; taskId: string; status: string; eventId?: unknown; error?: string } | undefined;
        const link = (await ctx.fns.procs.db.select({ sql: 'SELECT team_id, task_id FROM team.task_link WHERE agent_id=? AND plan_task_id=?', params: [String(self), taskId] }))[0];
        if (link) {
            const teamId = String(link.team_id), tid = String(link.task_id);
            try {
                const row = async () => (await ctx.fns.procs.db.select({ sql: 'SELECT status, version, assignee_agent_id FROM team.task WHERE team_id=? AND id=?', params: [teamId, tid] }))[0];
                let t = await row();
                if (!t) throw new Error('team task ' + tid + ' is gone');
                if (String(t.assignee_agent_id) !== String(self)) throw new Error('team task ' + tid + ' is assigned to ' + t.assignee_agent_id);
                const key = 'report:' + self + ':' + tid + ':' + at;
                if (t.status === 'assigned' || t.status === 'blocked' || t.status === 'paused') {
                    await ctx.fns.team.executeCommand({ teamId, requestKey: key + ':start', expectedVersion: Number(t.version), command: { action: 'taskTransition', taskId: tid, transition: { action: t.status === 'assigned' ? 'start' : 'resume' } } });
                    t = await row();
                }
                if (t.status === 'working') {
                    const res = await ctx.fns.team.executeCommand({ teamId, requestKey: key + ':submit', expectedVersion: Number(t.version), command: { action: 'taskTransition', taskId: tid, transition: { action: 'submit', summary: report.summary, artifacts: report.files, verification: report.checks.join('\n') || 'not checked', report } } });
                    team = { teamId, taskId: tid, status: 'review', eventId: res.eventId };
                } else team = { teamId, taskId: tid, status: String(t.status), error: 'not submitted: task is ' + t.status };
            } catch (e) { team = { teamId, taskId: tid, status: 'unchanged', error: String((e as Error)?.message ?? e).slice(0, 300) }; }
        }
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { agentId: String(self), taskId, status: String(out.result?.status ?? ''), report, ...(team ? { team } : {}), ...(memo ? { memo } : {}) };
}

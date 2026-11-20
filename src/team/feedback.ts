/**
 * Sends the owner's comment on a task to its assignee and returns handed-in work for rework
 *
 * Owner (signed-in person) only. Team task: in review it records changes (reason = comment) so the task goes back to assigned and the assignee is notified; otherwise a say to the assignee in the task thread. Delegated child task (agentId): a notification from the person into the child chat via session.enqueueNotification, or to its manager (parent) when the child is archived; the comment is also kept on the plan task as feedback[]. Visible in the team timeline / chat feed. A comment on a finished (done) team task, or on a done task of an archived child (a live child already gets the comment itself), also goes to team.reflect, so the executor persona draws conclusions into its memory (review → rework instead).
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.text Comment text, up to 8000 characters.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** Comment text, up to 8000 characters. */
        text: string;
    },
): Promise<{kind:"team"|"child"; delivered:string; to:string; reopened:boolean; [k:string]:unknown}> {
    type Row = Record<string, any>;
        const text = String(opts.text ?? '').replace(/\u0000/g, '').trim();
        if (!text) throw new Error('Комментарий пустой');
        if (text.length > 8000) throw new Error('Комментарий длиннее 8000 символов');
        const actor = await ctx.fns.team.resolveActor({});
        if (actor.kind !== 'user') throw new Error('Feedback is sent on behalf of the signed-in person');
        const key = 'team-feedback:' + Bun.randomUUIDv7();
        const taskId = String(opts.taskId ?? '').trim();
        if (!taskId) throw new Error('taskId required');
        if (opts.agentId) {
            const agentId = String(opts.agentId);
            if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
            const rows = await ctx.fns.procs.db.select({ sql: 'SELECT id, parent_id, archived_at, scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[];
            const a = rows[0]; if (!a) throw new Error('Agent not found');
            const sp = typeof a.scratchpad === 'string' ? JSON.parse(a.scratchpad || '{}') : (a.scratchpad ?? {});
            const t = (sp.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
            if (!t) throw new Error('No plan task ' + taskId);
            const archived = a.archived_at != null;
            const to = archived ? String(a.parent_id ?? '') : agentId;
            if (!to) throw new Error('Archived agent has no manager to notify');
            const body = archived
                ? 'Комментарий владельца к задаче «' + String(t.title ?? taskId) + '» (' + taskId + ') архивного субагента ' + agentId + '. Субагент в архиве — переоткрой работу (новый delegate или unarchive) и учти:\n\n' + text
                : 'Комментарий владельца к твоей задаче «' + String(t.title ?? taskId) + '» (' + taskId + '). Не согласен с результатом или есть замечание — разбери и доработай, затем обнови отчёт (team.reportTask) и сообщи итог:\n\n' + text;
            const sent = await ctx.fns.session.enqueueNotification({ to, key, text: body, originalAuthor: actor.id });
            await ctx.fns.session.mutateScratchpad({ id: agentId, mutate: (s: Row) => {
                const task = (s.plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
                if (task) { task.feedback = Array.isArray(task.feedback) ? task.feedback : []; task.feedback.push({ at: Date.now(), by: actor.id, text, to }); task.feedback = task.feedback.slice(-50); }
                return null;
            } });
            let reflect: unknown = null;
            if (t.status === 'done' && archived) { try { reflect = await ctx.fns.team.reflect({ kind: 'comment', taskId, agentId, assigneeAgentId: agentId, title: String(t.title ?? taskId), comment: text }); } catch (e) { reflect = { error: String((e as Error)?.message ?? e).slice(0, 200) }; } }
            try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
            return { kind: 'child', reflect, delivered: archived ? 'manager' : 'agent', to, reopened: false, messageIdx: sent.messageIdx };
        }
        const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
        let team: any = null; let task: Row | undefined;
        for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); const t = g.tasks.find((x: Row) => x.id === taskId); if (t) { team = g; task = t; break; } } catch {} }
        if (!team || !task) throw new Error('Task not found or access denied');
        const teamId = String(team.team.id);
        const assignee = task.assignee_agent_id ? String(task.assignee_agent_id) : String(team.team.supervisor_agent_id);
        // Review means the assignee already handed in: reject the submission so reduceTask returns it to assigned
        // (changes -> assigned, deadline re-armed). The changes event carries the comment and is delivered to the assignee.
        if (task.status === 'review' && task.current_submission_id) {
            const out = await ctx.fns.team.executeCommand({ teamId, requestKey: key, expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'changes', submissionId: String(task.current_submission_id), reason: text } } });
            return { kind: 'team', delivered: 'changes', to: assignee, reopened: true, eventId: out.eventId };
        }
        const out = await ctx.fns.team.executeCommand({ teamId, requestKey: key, expectedVersion: Number(team.team.version), command: { action: 'say', text: 'Комментарий владельца: ' + text, to: assignee, taskId } });
        let reflect: unknown = null;
        if (task.status === 'done' && task.assignee_agent_id) { try { reflect = await ctx.fns.team.reflect({ kind: 'comment', taskId, assigneeAgentId: assignee, title: String(task.title ?? taskId), comment: text }); } catch (e) { reflect = { error: String((e as Error)?.message ?? e).slice(0, 200) }; } }
        return { kind: 'team', reflect, delivered: 'say', to: assignee, reopened: false, eventId: out.eventId, ...(task.status === 'done' ? { note: 'done is terminal: reduceTask cannot reopen it; the comment is in the task thread' } : {}) };
}

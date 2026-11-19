/**
 * Report how far along the caller is on a task it is working on
 *
 * Call at every noticeable step with the current stage in a few words. Percent and etaMinutes are optional legacy fields; do not ask agents for them. Works for team tasks (latest values on team.task, public 'progress' event in the task timeline, also counts as a progress report for deadlines; assignee or owner only) and for the caller's own delegated plan task (scratchpad.plan.tasks[i].progress). Does not change task status.
 * @param opts.taskId Team task id, or plan task id in the caller's own plan.
 * @param opts.stage Current stage in a few words.
 * @param opts.percent Optional legacy readiness in percent. @minimum 0 @maximum 100
 * @param opts.etaMinutes Optional legacy minutes of work left. @minimum 0 @maximum 10080
 * @param opts.note Short free-form note.
 * @param opts.teamId Team id when the task id is ambiguous.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id in the caller's own plan. */
        taskId: string;
        /** Current stage in a few words. */
        stage?: string;
        /** Optional legacy readiness in percent. @minimum 0 @maximum 100 */
        percent?: number;
        /** Optional legacy minutes of work left. @minimum 0 @maximum 10080 */
        etaMinutes?: number;
        /** Short free-form note. */
        note?: string;
        /** Team id when the task id is ambiguous. */
        teamId?: string;
    },
): Promise<{ scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; eventId: string | null; values: Record<string, unknown>; at: number }> {
    const percent = opts.percent == null ? undefined : Math.round(Number(opts.percent));
    if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new Error('progress: percent must be 0..100');
    const eta = opts.etaMinutes == null ? undefined : Math.round(Number(opts.etaMinutes));
    if (eta !== undefined && (!Number.isFinite(eta) || eta < 0 || eta > 10080)) throw new Error('progress: etaMinutes must be 0..10080');
    const stage = opts.stage?.trim().slice(0, 200) || undefined;
    const note = opts.note?.trim().slice(0, 500) || undefined;
    if (percent === undefined && !stage && !note) throw new Error('progress: stage required');
    return await ctx.fns.team.recordProgress({ kind: 'progress', taskId: opts.taskId, teamId: opts.teamId, values: { ...(percent !== undefined ? { percent } : {}), ...(stage ? { stage } : {}), ...(eta !== undefined ? { etaMinutes: eta } : {}), ...(note ? { note } : {}) } });
}

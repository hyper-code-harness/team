/**
 * Set the work estimate for a task the caller has taken
 *
 * Call right after claiming or starting a task: its size S, M or L (S — up to ~15 min, M — up to an hour, L — more) and roughly how many steps it will take. Legacy callers may still pass minutes; they are mapped to a size (≤15 → S, ≤60 → M, else L). Works for team tasks (stored on team.task, public 'estimate' event in the task timeline; assignee or owner only) and for the caller's own delegated plan task (stored on scratchpad.plan.tasks[i].estimate). Re-estimating overwrites the latest value; every call stays in the timeline. The board compares elapsed time with the estimate.
 * @param opts.taskId Team task id, or plan task id in the caller's own plan.
 * @param opts.size Task size: S (up to ~15 min), M (up to an hour), L (more).
 * @param opts.minutes Deprecated: expected minutes, mapped to a size when size is not given. @minimum 1 @maximum 10080
 * @param opts.steps Expected number of noticeable steps. @minimum 1 @maximum 1000
 * @param opts.note Short reasoning behind the estimate.
 * @param opts.teamId Team id when the task id is ambiguous.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id in the caller's own plan. */
        taskId: string;
        /** Task size: S (up to ~15 min), M (up to an hour), L (more). */
        size?: 'S' | 'M' | 'L';
        /** Deprecated: expected minutes, mapped to a size when size is not given. @minimum 1 @maximum 10080 */
        minutes?: number;
        /** Expected number of noticeable steps. @minimum 1 @maximum 1000 */
        steps?: number;
        /** Short reasoning behind the estimate. */
        note?: string;
        /** Team id when the task id is ambiguous. */
        teamId?: string;
    },
): Promise<{ scope: 'team' | 'plan'; taskId: string; teamId: string | null; agentId: string | null; eventId: string | null; values: Record<string, unknown>; at: number }> {
    const minutes = opts.minutes == null ? undefined : Math.round(Number(opts.minutes));
    if (minutes !== undefined && (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080)) throw new Error('estimate: minutes must be 1..10080');
    const raw = opts.size == null ? '' : String(opts.size).trim().toUpperCase();
    if (raw && !['S', 'M', 'L'].includes(raw)) throw new Error('estimate: size must be S, M or L');
    const size = (raw || (minutes === undefined ? '' : minutes <= 15 ? 'S' : minutes <= 60 ? 'M' : 'L')) as 'S' | 'M' | 'L' | '';
    if (!size) throw new Error('estimate: size (S|M|L) required');
    const steps = opts.steps == null ? undefined : Math.round(Number(opts.steps));
    if (steps !== undefined && (!Number.isFinite(steps) || steps < 1 || steps > 1000)) throw new Error('estimate: steps must be 1..1000');
    const note = opts.note?.trim().slice(0, 500) || undefined;
    return await ctx.fns.team.recordProgress({ kind: 'estimate', taskId: opts.taskId, teamId: opts.teamId, values: { size, ...(raw ? {} : { minutes }), ...(steps !== undefined ? { steps } : {}), ...(note ? { note } : {}) } });
}

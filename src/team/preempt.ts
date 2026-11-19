/**
 * Hard-interrupt an assignee: pause current work and put an urgent task at the head of their queue.
 *
 * Supervisor or owner only. Atomically pauses the assignee working or blocked task with the note, assigns the urgent task with the lowest rank and emits a preempt event with delivery. After commit the assignee also gets an urgent agent message when the caller is an agent; a running turn is not force-stopped. Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current team version. @minimum 1
 * @param opts.urgentTaskId Never-started urgent task identifier.
 * @param opts.note Why the current work is paused; stored as paused note.
 * @param opts.assigneeAgentId Target roster member; required when the urgent task is unassigned.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Stable intent key; reuse only for exact retries. */
        requestKey: string;
        /** Current team version. @minimum 1 */
        expectedVersion: number;
        /** Never-started urgent task identifier. */
        urgentTaskId: string;
        /** Why the current work is paused; stored as paused note. */
        note: string;
        /** Target roster member; required when the urgent task is unassigned. */
        assigneeAgentId?: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'preempt',urgentTaskId:opts.urgentTaskId,note:opts.note,...(opts.assigneeAgentId?{assigneeAgentId:opts.assigneeAgentId}:{})}});
}

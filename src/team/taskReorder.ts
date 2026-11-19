/**
 * Insert never-started work at a chosen position of the backlog or an assignee queue.
 *
 * Queue-insert intervention for supervisor or owner: sets rank (lower runs first) and optionally assigns the task, so the assignee picks it up after current work instead of being interrupted. Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current task version. @minimum 1
 * @param opts.taskId Never-started todo or assigned task identifier.
 * @param opts.rank New position; lower runs first, fractions allowed for inserts between neighbours.
 * @param opts.assigneeAgentId Roster member whose queue receives the task; omitted keeps the current queue.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Stable intent key; reuse only for exact retries. */
        requestKey: string;
        /** Current task version. @minimum 1 */
        expectedVersion: number;
        /** Never-started todo or assigned task identifier. */
        taskId: string;
        /** New position; lower runs first, fractions allowed for inserts between neighbours. */
        rank: number;
        /** Roster member whose queue receives the task; omitted keeps the current queue. */
        assigneeAgentId?: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'taskReorder',taskId:opts.taskId,rank:opts.rank,...(opts.assigneeAgentId?{assigneeAgentId:opts.assigneeAgentId}:{})}});
}

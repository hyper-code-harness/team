/**
 * Assign never-started work to a fixed roster member.
 *
 * Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result. A notification is not a task completion or external-action authorization.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current normative team or task version. @minimum 1
 * @param opts.taskId Never-started task identifier.
 * @param opts.assigneeAgentId Fixed roster assignee.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Stable intent key; reuse only for exact retries. */
        requestKey: string;
        /** Current normative team or task version. @minimum 1 */
        expectedVersion: number;
        /** Never-started task identifier. */
        taskId: string;
        /** Fixed roster assignee. */
        assigneeAgentId: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'taskAssign',taskId:opts.taskId,assigneeAgentId:opts.assigneeAgentId}});
}

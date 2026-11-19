/**
 * Claim an unassigned backlog task for the calling roster agent.
 *
 * Moves todo to assigned with the caller as assignee; fails while any dependsOn task is not done. Concurrent claims serialize on the team row: one wins, the other gets a version conflict. Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current task version. @minimum 1
 * @param opts.taskId Unassigned todo task identifier.
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
        /** Unassigned todo task identifier. */
        taskId: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'taskTransition',taskId:opts.taskId,transition:{action:'claim'}}});
}

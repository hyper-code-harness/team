/**
 * Apply an explicit assignee or reviewer task transition.
 *
 * Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result. A notification is not a task completion or external-action authorization.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current normative team or task version. @minimum 1
 * @param opts.taskId Task identifier.
 * @param opts.transition Explicit action with submission or review evidence.
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
        /** Task identifier. */
        taskId: string;
        /** Explicit action with submission or review evidence. */
        transition: types.team.Transition;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'taskTransition',taskId:opts.taskId,transition:opts.transition}});
}

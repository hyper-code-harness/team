/**
 * Record public evidence or progress without waking other members.
 *
 * Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result. A notification is not a task completion or external-action authorization.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current normative team or task version. @minimum 1
 * @param opts.text Public report content.
 * @param opts.kind Report category; progress requires own active task.
 * @param opts.taskId Related task identifier.
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
        /** Public report content. */
        text: string;
        /** Report category; progress requires own active task. */
        kind: "milestone"|"finding"|"risk"|"decision"|"progress";
        /** Related task identifier. */
        taskId?: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'report',text:opts.text,kind:opts.kind,...(opts.taskId?{taskId:opts.taskId}:{})}});
}

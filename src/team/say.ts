/**
 * Post a public team message with explicit notification recipients.
 *
 * Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result. A notification is not a task completion or external-action authorization.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current normative team or task version. @minimum 1
 * @param opts.text Public message visible to the entire team.
 * @param opts.to Notification recipient agent ID, or all.
 * @param opts.taskId Related task in this team.
 * @param opts.replyTo Prior event ID for a directed reply.
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
        /** Public message visible to the entire team. */
        text: string;
        /** Notification recipient agent ID, or all. */
        to: string;
        /** Related task in this team. */
        taskId?: string;
        /** Prior event ID for a directed reply. */
        replyTo?: string;
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'say',text:opts.text,to:opts.to,...(opts.taskId?{taskId:opts.taskId}:{}),...(opts.replyTo?{replyTo:opts.replyTo}:{})}});
}

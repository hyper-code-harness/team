/**
 * Create a board task with explicit acceptance criteria.
 *
 * Uses injected caller identity and the atomic versioned command boundary. Exact retries return the original committed result. A notification is not a task completion or external-action authorization.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current normative team or task version. @minimum 1
 * @param opts.taskId New task identifier.
 * @param opts.title Task title.
 * @param opts.instructions Concrete work instructions.
 * @param opts.acceptanceCriteria Evidence required for acceptance.
 * @param opts.assigneeAgentId Fixed roster member, omitted for todo.
 * @param opts.rank Position in backlog or assignee queue; lower runs first. Defaults to the end of the queue.
 * @param opts.groupKey Optional group label for related tasks.
 * @param opts.dependsOn Existing task identifiers that must be done before claim.
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
        /** New task identifier. */
        taskId: string;
        /** Task title. */
        title: string;
        /** Concrete work instructions. */
        instructions: string;
        /** Evidence required for acceptance. */
        acceptanceCriteria: string;
        /** Fixed roster member, omitted for todo. */
        assigneeAgentId?: string;
        /** Position in backlog or assignee queue; lower runs first. Defaults to the end of the queue. */
        rank?: number;
        /** Optional group label for related tasks. */
        groupKey?: string;
        /** Existing task identifiers that must be done before claim. */
        dependsOn?: string[];
    },
): Promise<Record<string,unknown>> {
    return await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'taskCreate',taskId:opts.taskId,title:opts.title,instructions:opts.instructions,acceptanceCriteria:opts.acceptanceCriteria,...(opts.assigneeAgentId?{assigneeAgentId:opts.assigneeAgentId}:{}),...(opts.rank!==undefined?{rank:opts.rank}:{}),...(opts.groupKey?{groupKey:opts.groupKey}:{}),...(opts.dependsOn?{dependsOn:opts.dependsOn}:{})}});
}

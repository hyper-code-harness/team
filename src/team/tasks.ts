/**
 * Read the authorized current task board for a team
 *
 * Ordered by assignee (backlog first), then rank: each agent's queue reads top-down. Use to inspect assignments, task versions, review state and deadlines. Access is inherited from team.get and requires the owner or a roster member from injected context.
 * @param opts.teamId Persistent team identifier.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persistent team identifier. */
        teamId: string;
    },
): Promise<{id:string;team_id:string;title:string;instructions:string;acceptance_criteria:string;assignee_agent_id:string|null;status:'todo'|'assigned'|'working'|'blocked'|'paused'|'review'|'done'|'cancelled';version:number;ever_started_at:number|null;current_submission_id:string|null;blocked_reason:string|null;progress_due_at:number|null;last_progress_at:number|null;deadline_generation:number;rank:number|null;group_key:string|null;depends_on:string[];paused_note:string|null}[]> {
    return (await ctx.fns.team.get({teamId:opts.teamId})).tasks;
}

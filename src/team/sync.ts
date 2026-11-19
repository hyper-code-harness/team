/**
 * Refresh the authorized team state before taking work
 *
 * Use before deciding on team commands to obtain the passport, current roster, task versions and delivery status. Read-only alias of team.get; does not acknowledge notifications or mutate assignments.
 * @param opts.teamId Persistent team identifier.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persistent team identifier. */
        teamId: string;
    },
): Promise<{team:{id:string;owner_user_id:string;title:string;goal:string;supervisor_agent_id:string;status:'draft'|'active'|'archived';version:number;next_seq:number;progress_window_ms:number;created_at:number};members:{team_id:string;agent_id:string;role:string;responsibilities:string;active:boolean}[];tasks:{id:string;team_id:string;title:string;instructions:string;acceptance_criteria:string;assignee_agent_id:string|null;status:'todo'|'assigned'|'working'|'blocked'|'paused'|'review'|'done'|'cancelled';version:number;ever_started_at:number|null;current_submission_id:string|null;blocked_reason:string|null;progress_due_at:number|null;last_progress_at:number|null;deadline_generation:number;rank:number|null;group_key:string|null;depends_on:string[];paused_note:string|null}[];deliveries:{id:string;team_id:string;event_id:string;recipient_agent_id:string;status:'pending'|'claimed'|'delivered'|'failed';attempts:number;next_at:number;last_error:string|null}[]}> {
    return await ctx.fns.team.get({teamId:opts.teamId});
}

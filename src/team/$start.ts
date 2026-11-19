/** Boot: forward core agent/plan change signals to the "team" live topic (team.liveBridge). */
export default async function (ctx: Context, _session: Session | null, _opts?: {}): Promise<void> {
    ctx.fns.team.liveBridge({});
}

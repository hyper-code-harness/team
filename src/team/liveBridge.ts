/**
 * Forwards core change signals to the "team" live topic so team boards (`@live team`) redraw at once.
 *
 * The core never refreshes "team": child plans (session.plan/updatePlan/done), agent.finishTask, agent.delegate,
 * run start/end and archive refresh "agent-meta" or "agents" instead. This installs one server-side subscriber
 * that turns those into a debounced procs.events.refresh({ topic: "team" }). Idempotent: a second call replaces
 * the previous subscriber. Called from team/$start.ts at boot.
 * @param opts.debounceMs Coalescing window in ms. @default 250
 * @returns Whether the bridge is installed.
 */
export default function (ctx: Context, _session: Session | null, opts: {
    /** Coalescing window in ms. @default 250 */
    debounceMs?: number;
} = {}): { installed: boolean } {
    const st: any = ((ctx.state as any).team ??= {});
    try { st.liveBridgeUnsub?.(); } catch {}
    if (st.liveBridgeTimer) clearTimeout(st.liveBridgeTimer);
    st.liveBridgeTimer = null;
    const wait = Math.max(50, opts.debounceMs ?? 250);
    const watched = new Set(["agent-meta", "agents"]);
    st.liveBridgeUnsub = ctx.fns.procs.events.subscribe({
        topics: [...watched],
        handler: (e: any) => {
            if (!e || !watched.has(e.topic) || e.type !== "refresh") return;
            if (st.liveBridgeTimer) return;
            st.liveBridgeTimer = setTimeout(() => {
                st.liveBridgeTimer = null;
                try { ctx.fns.procs.events.refresh({ topic: "team", reason: `core:${e.topic}` }); } catch {}
            }, wait);
        },
    });
    return { installed: true };
}

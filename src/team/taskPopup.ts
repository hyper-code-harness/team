/**
 * Opens a task card (team.taskView) almost full-screen in the app popup
 *
 * Popup RPC target for hx-popup="team.taskPopup" with hx-popup-params {taskId, agentId?}: wraps team.taskView in ui.popupContent with the wide file-preview preset. Use on board cards via w.* action { popup: { method: "team.taskPopup", params } } or ui.popup.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.title Ignored: the popup header is the card's own head line (assignee face + name + task title, via <template data-popup-head>); «Задача» is only the plain-text fallback.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** Ignored: the header comes from the card's head line; «Задача» is the plain-text fallback. */
        title?: string;
    },
): Promise<Response> {
    const html = await ctx.fns.team.taskView({ taskId: opts.taskId, ...(opts.agentId ? { agentId: opts.agentId } : {}) });
        // plain-text fallback; the card's <template data-popup-head> (face + name + task title) replaces it in the popup header
        const title = 'Задача';
        // file-preview is the core's wide popup preset (min(90rem, 100vw-2rem) x 97vh, body without padding/scroll),
        // so the card brings its own scroll container.
        const content = ctx.fns.ui.popupContent({ title, kind: 'file-preview', class: 'block h-full w-full overflow-auto bg-base-200', html });
        return new Response(content, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

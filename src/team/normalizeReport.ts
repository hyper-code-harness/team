/**
 * Validate and bound a structured task report into the canonical shape
 *
 * Pure helper. Turns a partial or legacy report (or only submit summary/artifacts/verification) into {summary, done, decisions[{what,why}], checks, files, questions, notDone, next[{title,why,kind}], visuals[{title,kind,path|svg|source|html|url}]} with trimmed, size-bounded strings. Use before storing a report in a submit event or a delegated plan task.
 * @param opts.report Report as written by the agent; may be partial.
 * @param opts.fallbackSummary Summary used when the report has none (submit summary).
 * @param opts.fallbackFiles Files used when the report lists none (submit artifacts).
 * @param opts.fallbackCheck Check used when the report lists none (submit verification).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Report as written by the agent; may be partial. */
        report?: Partial<types.team.TaskReport> | null;
        /** Summary used when the report has none (submit summary). */
        fallbackSummary?: string;
        /** Files used when the report lists none (submit artifacts). */
        fallbackFiles?: string[];
        /** Check used when the report lists none (submit verification). */
        fallbackCheck?: string;
    },
): Promise<Required<types.team.TaskReport>> {
    const r: any = opts.report && typeof opts.report === 'object' ? opts.report : {};
        const clean = (v: unknown, n = 2000) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
        const list = (v: unknown, max = 50) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(x => clean(x)).filter(Boolean).slice(0, max);
        const summary = clean(r.summary || opts.fallbackSummary, 4000);
        if (!summary) throw new Error('Report summary required');
        const decisions = (Array.isArray(r.decisions) ? r.decisions : []).slice(0, 30)
            .map((d: any) => typeof d === 'string' ? { what: clean(d), why: '' } : { what: clean(d?.what), why: clean(d?.why) })
            .filter((d: any) => d.what);
        const checks = list(r.checks); if (!checks.length && clean(opts.fallbackCheck)) checks.push(clean(opts.fallbackCheck));
        const files = list(r.files ?? opts.fallbackFiles, 100);
        const next = (Array.isArray(r.next) ? r.next : []).slice(0, 20)
            .map((n: any) => typeof n === 'string' ? { title: clean(n, 500), why: '', kind: 'new' as const } : { title: clean(n?.title ?? n?.what, 500), why: clean(n?.why, 1000), kind: n?.kind === 'continue' ? 'continue' as const : 'new' as const })
            .filter((n: any) => n.title);
        const kinds = ['image', 'svg', 'mermaid', 'html', 'canvas'];
        const visuals = (Array.isArray(r.visuals) ? r.visuals : []).slice(0, 12).map((v: any) => {
            if (!v || typeof v !== 'object') return null;
            const kind = kinds.includes(v.kind) ? v.kind : v.svg ? 'svg' : v.source ? 'mermaid' : v.html ? 'html' : v.url && !v.path ? 'canvas' : 'image';
            const o: any = { title: clean(v.title, 200), kind };
            if (v.path) o.path = clean(v.path, 1000);
            if (v.url) o.url = clean(v.url, 2000);
            if (v.svg) o.svg = String(v.svg).replace(/\u0000/g, '').slice(0, 200000);
            if (v.source) o.source = clean(v.source, 20000);
            if (v.html) o.html = String(v.html).replace(/\u0000/g, '').slice(0, 100000);
            return o.path || o.url || o.svg || o.source || o.html ? o : null;
        }).filter(Boolean);
        return { summary, done: list(r.done), decisions, checks, files, questions: list(r.questions), notDone: list(r.notDone), next, visuals };
}

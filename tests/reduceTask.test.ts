import { describe, expect, test } from 'bun:test';

// Load only the pure reducer, without registering runtime plugins, opening a DB,
// or importing project modules. Runtime-only types disappear during transpilation.
const source = await Bun.file(new URL('../src/team/reduceTask.ts', import.meta.url)).text();
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
const { default: reduce } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const statuses = ['todo', 'assigned', 'working', 'blocked', 'review', 'done', 'cancelled'] as const;
type Status = typeof statuses[number];
const now = 10_000;
const windowMs = 5_000;
function task(status: Status = 'assigned') {
    return {
        id: 'task-1', teamId: 'team-1', title: 'Implement', instructions: 'Write code',
        acceptanceCriteria: 'Tests pass', assigneeAgentId: 'worker', status,
        version: 7, everStartedAt: ['working', 'blocked', 'review', 'done'].includes(status) ? 100 : null,
        currentSubmissionId: status === 'review' || status === 'done' ? 'submission-1' : null,
        blockedReason: status === 'blocked' ? 'Waiting for input' : null,
        progressDueAt: ['working', 'blocked'].includes(status) ? 9_000 : null,
        lastProgressAt: 90, deadlineGeneration: 2,
    };
}
type Task = ReturnType<typeof task>;
type Command = { action: string; reason?: string; summary?: string; verification?: string; artifacts?: string[]; submissionId?: string };
function options(t: Task, command: Command) {
    return { task: t, command, actorKind: 'agent' as 'agent' | 'user', actorId: 'worker',
        supervisorId: 'supervisor', slotTaskId: null as string | null,
        now, submissionId: 'submission-2', progressWindowMs: windowMs };
}
// A fail-fast mock guarantees that a future reducer change cannot quietly use
// any runtime dependency (including DB) from this isolated test suite.
const noRuntime = new Proxy({}, { get(_target, key) { throw new Error(`Pure reducer accessed runtime: ${String(key)}`); } });
async function run(t: Task, command: Command, overrides: Partial<ReturnType<typeof options>> = {}) {
    Object.freeze(t);
    if (command.artifacts) Object.freeze(command.artifacts);
    Object.freeze(command);
    return reduce(noRuntime, null, { ...options(t, command), ...overrides }) as Promise<Task>;
}
const submit = () => ({ action: 'submit', summary: 'Implemented', artifacts: ['git:abc123:path/file.ts'], verification: 'bun test passed' });
const review = (action = 'approve', submissionId = 'submission-1') => ({ action, submissionId, reason: 'Checked acceptance criteria' });
const supervisor = { actorId: 'supervisor' };
const owner = { actorKind: 'user' as const, actorId: 'owner' };

describe('pure team reducer: state and immutable snapshots', () => {
    test('start acquires work, records first start, arms deadline, increments version exactly once', async () => {
        const before = task();
        const copy = structuredClone(before);
        const next = await run(before, { action: 'start' });
        expect(next).toEqual({ ...before, status: 'working', everStartedAt: now, progressDueAt: now + windowMs, deadlineGeneration: 3, version: 8 });
        expect(next).not.toBe(before);
        expect(before).toEqual(copy);
    });
    test('block retains started identity; resume clears reason and rearms deadline', async () => {
        const initial = task('working');
        const blocked = await run(initial, { action: 'block', reason: 'External prerequisite' }, { slotTaskId: initial.id });
        expect(blocked).toEqual({ ...initial, status: 'blocked', blockedReason: 'External prerequisite', progressDueAt: 15_000, deadlineGeneration: 3, version: 8 });
        const resumed = await run(blocked, { action: 'resume' }, { slotTaskId: initial.id, now: 12_000 });
        expect(resumed).toEqual({ ...blocked, status: 'working', blockedReason: null, progressDueAt: 17_000, deadlineGeneration: 4, version: 9 });
        expect(initial.status).toBe('working');
        expect(blocked.status).toBe('blocked');
    });
    test('submit leaves working state, clears deadline and pins supplied evidence event ID', async () => {
        const before = task('working');
        const command = submit();
        const commandCopy = structuredClone(command);
        const next = await run(before, command);
        expect(next).toEqual({ ...before, status: 'review', currentSubmissionId: 'submission-2', progressDueAt: null, blockedReason: null, version: 8 });
        expect(command).toEqual(commandCopy);
        expect(before.currentSubmissionId).toBeNull();
    });
    test('approve preserves evidence reference and prior immutable review snapshot', async () => {
        const before = task('review');
        const next = await run(before, review(), supervisor);
        expect(next).toEqual({ ...before, status: 'done', progressDueAt: null, version: 8 });
        expect(next.currentSubmissionId).toBe('submission-1');
        expect(before.status).toBe('review');
    });
    test('changes/restart/resubmit produce a new reference without rewriting old evidence', async () => {
        const first = task('review');
        const changes = await run(first, review('changes'), supervisor);
        expect(changes).toEqual({ ...first, status: 'assigned', currentSubmissionId: null, progressDueAt: 15_000, deadlineGeneration: 3, version: 8 });
        const restarted = await run(changes, { action: 'start' });
        expect(restarted.everStartedAt).toBe(first.everStartedAt);
        expect(restarted.assigneeAgentId).toBe(first.assigneeAgentId);
        const second = await run(restarted, submit());
        expect(second.currentSubmissionId).toBe('submission-2');
        expect(first.currentSubmissionId).toBe('submission-1');
        expect(first.status).toBe('review');
        expect(changes.currentSubmissionId).toBeNull();
        await expect(run(second, review('approve'), supervisor)).rejects.toThrow('Stale submission');
        await expect(run(second, review('changes'), supervisor)).rejects.toThrow('Stale submission');
        const done = await run(second, review('approve', 'submission-2'), supervisor);
        expect(done.currentSubmissionId).toBe('submission-2');
        expect(done.status).toBe('done');
    });

    const transitions = [
        { command: { action: 'start' }, from: 'assigned' },
        { command: { action: 'block', reason: 'Dependency' }, from: 'working' },
        { command: { action: 'resume' }, from: 'blocked' },
        { command: submit(), from: 'working' },
        { command: review('approve'), from: 'review' },
        { command: review('changes'), from: 'review' },
    ];
    for (const { command, from } of transitions) {
        for (const status of statuses.filter(s => s !== from)) {
            test(`${command.action} rejects ${status} without changing state`, async () => {
                const before = task(status);
                const copy = structuredClone(before);
                await expect(run(before, command, ['approve', 'changes'].includes(command.action) ? supervisor : {})).rejects.toThrow();
                expect(before).toEqual(copy);
            });
        }
    }
    test('arbitrary status mutation action is rejected', async () => {
        await expect(run(task(), { action: 'setStatus' })).rejects.toThrow('Unsupported transition');
    });
});

describe('authority', () => {
    for (const [status, command] of [
        ['assigned', { action: 'start' }], ['working', { action: 'block', reason: 'Dependency' }],
        ['blocked', { action: 'resume' }], ['working', submit()],
    ] as [Status, Command][]) {
        for (const actor of [supervisor, owner, { actorId: 'other-worker' }, { actorKind: 'user' as const, actorId: 'worker' }]) {
            test(`only agent assignee can ${command.action}; reject ${actor.actorId}/${'actorKind' in actor ? actor.actorKind : 'agent'}`, async () => {
                await expect(run(task(status), command, actor)).rejects.toThrow('Only assignee');
            });
        }
    }
    for (const action of ['approve', 'changes']) {
        for (const actorId of ['worker', 'other-worker']) {
            test(`${actorId} cannot ${action}`, async () => {
                await expect(run(task('review'), review(action), { actorId })).rejects.toThrow('Reviewer authority');
            });
        }
        test(`owner may ${action} ordinary work`, async () => {
            expect((await run(task('review'), review(action), owner)).status).toBe(action === 'approve' ? 'done' : 'assigned');
        });
        test(`supervisor cannot self-${action}; owner can review supervisor work`, async () => {
            const ownWork = { ...task('review'), assigneeAgentId: 'supervisor' };
            await expect(run(ownWork, review(action), supervisor)).rejects.toThrow('supervisor work requires owner');
            expect((await run(ownWork, review(action), owner)).status).toBe(action === 'approve' ? 'done' : 'assigned');
        });
    }
});

describe('one working/blocked slot', () => {
    for (const [status, action] of [['assigned', 'start'], ['blocked', 'resume']] as [Status, string][]) {
        test(`${action} rejects an occupied slot`, async () => {
            const before = task(status);
            await expect(run(before, { action }, { slotTaskId: 'other-active-task' })).rejects.toThrow('already has a working or blocked task');
            expect(before.status).toBe(status);
            expect(before.version).toBe(7);
        });
        for (const slotTaskId of [null, 'task-1']) {
            test(`${action} accepts empty or same-task slot: ${slotTaskId}`, async () => {
                expect((await run(task(status), { action }, { slotTaskId })).status).toBe('working');
            });
        }
    }
    // Slot persistence/enforcement across two tasks belongs to application/DB tests;
    // this reducer receives the already locked slot's task ID, not a slot table.
});

describe('cancel only never-started work', () => {
    for (const status of ['todo', 'assigned'] as const) {
        for (const actor of [owner, supervisor]) {
            test(`${actor.actorId} cancels never-started ${status}`, async () => {
                const before = task(status);
                expect(await run(before, { action: 'cancel' }, actor)).toEqual({ ...before, status: 'cancelled', progressDueAt: null, version: 8 });
            });
        }
        test(`assignee cannot cancel ${status}`, async () => {
            await expect(run(task(status), { action: 'cancel' })).rejects.toThrow('Supervisor or owner');
        });
    }
    for (const status of statuses) {
        for (const actor of [owner, supervisor]) {
            test(`${actor.actorId} cannot cancel started ${status}, including epoch-zero start`, async () => {
                await expect(run({ ...task(status), everStartedAt: 0 }, { action: 'cancel' }, actor)).rejects.toThrow('Started work cannot be cancelled');
            });
        }
        if (status !== 'todo' && status !== 'assigned') {
            test(`cancel rejects ${status} even with null start marker`, async () => {
                await expect(run({ ...task(status), everStartedAt: null }, { action: 'cancel' }, owner)).rejects.toThrow('Started work cannot be cancelled');
            });
        }
    }
    test('changes do not restore permission to cancel previously started work', async () => {
        const revised = await run(task('review'), review('changes'), supervisor);
        await expect(run(revised, { action: 'cancel' }, owner)).rejects.toThrow('Started work cannot be cancelled');
    });
});

describe('evidence and deadline validation', () => {
    for (const action of ['approve', 'changes']) {
        test(`${action} requires current immutable submission reference`, async () => {
            await expect(run(task('review'), review(action, 'old-submission'), supervisor)).rejects.toThrow('Stale submission');
            await expect(run({ ...task('review'), currentSubmissionId: null }, review(action), owner)).rejects.toThrow('Stale submission');
        });
        test(`${action} requires a nonblank reason`, async () => {
            await expect(run(task('review'), { ...review(action), reason: ' \n ' }, supervisor)).rejects.toThrow('Review reason required');
        });
    }
    test('block requires a reason', async () => {
        await expect(run(task('working'), { action: 'block', reason: '  ' })).rejects.toThrow('Blocked reason required');
    });
    for (const field of ['summary', 'verification'] as const) {
        test(`submission requires ${field}`, async () => {
            await expect(run(task('working'), { ...submit(), [field]: ' \n ' })).rejects.toThrow('Submission summary, artifacts and verification required');
        });
    }
    test('submission requires artifacts array but accepts an explicit empty array', async () => {
        await expect(run(task('working'), { ...submit(), artifacts: undefined })).rejects.toThrow('Submission summary, artifacts and verification required');
        expect((await run(task('working'), { ...submit(), artifacts: [] })).status).toBe('review');
    });
    for (const time of [NaN, Infinity, -Infinity]) {
        test(`rejects nonfinite transaction time ${time}`, async () => {
            await expect(run(task(), { action: 'start' }, { now: time })).rejects.toThrow('Invalid deadline policy');
        });
    }
    for (const duration of [999, 86_400_001, -1, Infinity]) {
        test(`rejects deadline policy out of bounds: ${duration}`, async () => {
            await expect(run(task(), { action: 'start' }, { progressWindowMs: duration })).rejects.toThrow('Invalid deadline policy');
        });
    }
    for (const duration of [1_000, 86_400_000]) {
        test(`accepts inclusive deadline policy bound: ${duration}`, async () => {
            expect((await run(task(), { action: 'start' }, { progressWindowMs: duration })).progressDueAt).toBe(now + duration);
        });
    }
});

describe('backlog claim, pause/preempt, resume from paused, cancel paused', () => {
    const unassigned = (extra: Record<string, unknown> = {}) => ({ ...task('todo'), assigneeAgentId: null, ...extra }) as unknown as Task;
    const paused = () => ({ ...task('blocked'), status: 'paused', blockedReason: null, progressDueAt: null, pausedNote: 'Urgent fix first' }) as unknown as Task;
    test('roster agent claims unassigned todo without dependencies', async () => {
        const next: any = await run(unassigned(), { action: 'claim' }, { actorId: 'other' });
        expect(next.status).toBe('assigned'); expect(next.assigneeAgentId).toBe('other'); expect(next.version).toBe(8);
        expect(next.everStartedAt).toBeNull(); expect(next.progressDueAt).toBeNull();
    });
    test('claim succeeds when every dependency is done', async () => {
        const next: any = await run(unassigned({ dependsOn: ['a', 'b'] }), { action: 'claim' }, { actorId: 'other', dependencyStatuses: { a: 'done', b: 'done' } } as any);
        expect(next.assigneeAgentId).toBe('other');
    });
    test('claim denied while a dependency is not done or unknown', async () => {
        await expect(run(unassigned({ dependsOn: ['a', 'b'] }), { action: 'claim' }, { actorId: 'other', dependencyStatuses: { a: 'done', b: 'review' } } as any)).rejects.toThrow('Dependencies not done: b');
        await expect(run(unassigned({ dependsOn: ['missing'] }), { action: 'claim' }, { actorId: 'other' })).rejects.toThrow('Dependencies not done: missing');
    });
    test('owner (user) cannot claim', async () => {
        await expect(run(unassigned(), { action: 'claim' }, { actorKind: 'user', actorId: 'owner' })).rejects.toThrow('Only a roster agent may claim');
    });
    for (const status of statuses.filter(s => s !== 'todo')) {
        test(`claim rejects ${status}`, async () => {
            await expect(run(task(status), { action: 'claim' }, { actorId: 'other' })).rejects.toThrow('Claim requires unassigned todo');
        });
    }
    test('claim rejects todo that already has an assignee', async () => {
        await expect(run(task('todo'), { action: 'claim' }, { actorId: 'other' })).rejects.toThrow('Claim requires unassigned todo');
    });
    for (const from of ['working', 'blocked'] as const) {
        for (const actor of [{ actorId: 'worker' }, { actorId: 'supervisor' }, { actorKind: 'user' as const, actorId: 'owner' }]) {
            test(`${actor.actorId} pauses ${from}: note stored, deadline cleared, slot released`, async () => {
                const next: any = await run(task(from), { action: 'pause', note: 'Urgent fix first' } as any, actor);
                expect(next.status).toBe('paused'); expect(next.pausedNote).toBe('Urgent fix first');
                expect(next.progressDueAt).toBeNull(); expect(next.everStartedAt).toBe(100); expect(next.version).toBe(8);
            });
        }
    }
    test('outsider agent cannot pause', async () => {
        await expect(run(task('working'), { action: 'pause', note: 'x' } as any, { actorId: 'other' })).rejects.toThrow('Assignee, supervisor or owner required');
    });
    test('pause requires a note', async () => {
        await expect(run(task('working'), { action: 'pause', note: '  ' } as any)).rejects.toThrow('Pause note required');
    });
    for (const status of statuses.filter(s => !['working', 'blocked'].includes(s))) {
        test(`pause rejects ${status}`, async () => {
            await expect(run(task(status), { action: 'pause', note: 'x' } as any)).rejects.toThrow('Pause requires working or blocked');
        });
    }
    test('assignee resumes paused with free slot: note cleared, deadline rearmed', async () => {
        const next: any = await run(paused(), { action: 'resume' });
        expect(next.status).toBe('working'); expect(next.pausedNote).toBeNull(); expect(next.progressDueAt).toBe(now + windowMs); expect(next.deadlineGeneration).toBe(3);
    });
    test('resume from paused needs a free slot', async () => {
        await expect(run(paused(), { action: 'resume' }, { slotTaskId: 'urgent' })).rejects.toThrow('working or blocked');
    });
    test('supervisor cannot resume someone else paused task', async () => {
        await expect(run(paused(), { action: 'resume' }, { actorId: 'supervisor' })).rejects.toThrow('Only assignee');
    });
    for (const actor of [{ actorId: 'supervisor' }, { actorKind: 'user' as const, actorId: 'owner' }]) {
        test(`${actor.actorId} cancels paused work with a reason`, async () => {
            const next: any = await run(paused(), { action: 'cancel', reason: 'User changed mind' }, actor);
            expect(next.status).toBe('cancelled'); expect(next.everStartedAt).toBe(100);
        });
    }
    test('cancel paused requires a reason', async () => {
        await expect(run(paused(), { action: 'cancel' }, { actorId: 'supervisor' })).rejects.toThrow('requires a reason');
    });
    test('assignee cannot cancel paused work', async () => {
        await expect(run(paused(), { action: 'cancel', reason: 'no' })).rejects.toThrow('Supervisor or owner required');
    });
    test('start from paused is rejected (start requires assigned)', async () => {
        await expect(run(paused(), { action: 'start' })).rejects.toThrow('Start requires assigned');
    });
    test('paused cannot be submitted', async () => {
        await expect(run(paused(), submit())).rejects.toThrow('Submit requires working');
    });
});

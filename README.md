# Team MVP

Open `/team/` to create a fixed-roster team from dedicated persistent owner sessions. The UI explains bootstrap, public visibility, board transitions and explicit review. Runtime workflow: [SKILL.md](SKILL.md). Delivery/testing/deployment record: [WORKLOG.md](WORKLOG.md).

**Operational status:** plugin functions, six-table `team` schema and owner UI are loaded. Automated delivery requires an owner-scoped maintenance grant **and** a ready tracked cron worker. The current running process has an untracked legacy cron loop; background activation remains blocked until a verified lifecycle handoff. No server restart was performed. Do not interpret grant creation, active team status or accepted notification as completed work.

Tests: `bun test tests/reduceTask.test.ts tests/routes.test.ts` (159 passing) and `bun test tests/integration.test.ts` (12 passing). Integration uses only its own disposable loopback PostgreSQL container and removes it afterward; never point it at the application database. Transport/cron APIs are mocked in domain integration, so this is not full end-to-end worker proof.

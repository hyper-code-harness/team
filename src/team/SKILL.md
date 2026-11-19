# Team

Private single-owner team board for trusted persistent agents. Membership, goal and supervisor freeze on activation. Call `team.sync` before working, then use versioned commands with a fresh requestKey per intent. Retrying the identical request returns its prior committed result; never change a replay payload.

Messages and reports are PUBLIC to the entire team. A recipient controls notification only. Task assignment is immutable after first start. One working/blocked task per member. Submit records immutable evidence, frees the work slot and requires explicit reviewer approval. Delivery acceptance never means task completion.

Implementation in progress: see WORKLOG.md for verified capabilities and limitations. No sandbox or exactly-once external action guarantee. All storage is in the dedicated PostgreSQL schema `team`.


Task report: on submit pass `report` {summary, done[], decisions[{what,why}], checks[], files[], questions[]}; a delegated child writes the same thing via `team.reportTask({taskId, report})` before `session.done`. Details in the plugin's SKILL.md.

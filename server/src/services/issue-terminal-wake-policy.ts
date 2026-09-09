import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

type ChildIssueWakeIdentity = {
  originKind?: string | null;
  originId?: string | null;
};

/**
 * Productivity-review completion persists its source continuation in the same
 * transaction as the terminal disposition. Every caller that also emits the
 * generic parent/child continuation must consult this predicate so alternate
 * terminal paths cannot queue a second source run under a different reason.
 */
export function shouldEnqueueGenericTerminalWakeForTarget(
  issue: ChildIssueWakeIdentity,
  targetIssueId: string,
) {
  return issue.originKind !== RECOVERY_ORIGIN_KINDS.issueProductivityReview
    || issue.originId !== targetIssueId;
}

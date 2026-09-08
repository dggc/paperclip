import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const LIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
const ACTIVE_RECOVERY_STATUSES = ["active", "escalated"] as const;
const REMEDIATION_WAKE_PREFIX = "execution-workspace-remediation:";

export type ExecutionWorkspaceIncidentClass =
  | "fallback_agent_home_cwd"
  | "missing_project_workspace_identity"
  | "mismatched_project_workspace_identity"
  | "stale_execution_workspace_binding"
  | "unrealized_isolated_workspace_request"
  | "non_reusable_reuse_existing_binding";

type IssueRow = Pick<typeof issues.$inferSelect,
  | "id" | "companyId" | "projectId" | "projectWorkspaceId" | "status"
  | "assigneeAgentId" | "responsibleUserId" | "identifier" | "executionWorkspaceId"
  | "executionWorkspacePreference" | "executionWorkspaceSettings"
>;
type ProjectRow = Pick<typeof projects.$inferSelect, "id" | "companyId" | "executionWorkspacePolicy">;
type ProjectWorkspaceRow = Pick<typeof projectWorkspaces.$inferSelect, "id" | "projectId" | "isPrimary">;
type ExecutionWorkspaceRow = Pick<typeof executionWorkspaces.$inferSelect,
  | "id" | "companyId" | "projectId" | "projectWorkspaceId" | "mode" | "strategyType"
  | "status" | "cwd" | "branchName" | "closedAt"
>;
type RecoveryActionRow = Pick<typeof issueRecoveryActions.$inferSelect,
  "id" | "sourceIssueId" | "status" | "cause" | "fingerprint"
> & { evidenceReason: string | null };
type HeartbeatRunRow = Pick<typeof heartbeatRuns.$inferSelect, "id" | "createdAt"> & {
  issueId: string | null;
  workspaceValidationReason: string | null;
};
type WakeupRow = Pick<typeof agentWakeupRequests.$inferSelect,
  "id" | "status" | "idempotencyKey" | "createdAt"
> & { issueId: string | null };
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbReader = Db | DbTransaction;

export type ExecutionWorkspaceRemediationSnapshot = {
  issue: IssueRow;
  project: ProjectRow | null;
  projectWorkspace: ProjectWorkspaceRow | null;
  primaryProjectWorkspace: ProjectWorkspaceRow | null;
  executionWorkspace: ExecutionWorkspaceRow | null;
  activeRecoveryActions: RecoveryActionRow[];
  latestRun: HeartbeatRunRow | null;
  remediationWake: WakeupRow | null;
  pathExists?: (value: string) => boolean;
};

export type SanitizedExecutionWorkspaceFinding = {
  issueId: string;
  issueIdentifier: string | null;
  incidentClasses: ExecutionWorkspaceIncidentClass[];
  fingerprint: string;
  recoveryActionIds: string[];
  evidence: {
    issueStatus: string;
    projectIdPresent: boolean;
    projectWorkspaceIdentity: "not_applicable" | "missing" | "matching" | "mismatched";
    requestedMode: string | null;
    effectiveMode: string;
    effectiveStrategy: string;
    executionWorkspace: {
      bound: boolean;
      mode: string | null;
      strategyType: string | null;
      status: string | null;
      hasCwd: boolean;
      hasBranch: boolean;
      pathPresent: boolean | null;
      projectIdentityMatches: boolean | null;
      projectWorkspaceIdentityMatches: boolean | null;
    };
    remediationPending: boolean;
  };
};

export type ExecutionWorkspaceFleetAudit = {
  version: 1;
  dryRun: true;
  generatedAt: string;
  companyId: string;
  checkedIssueCount: number;
  findingCount: number;
  incidentCounts: Record<ExecutionWorkspaceIncidentClass, number>;
  findings: SanitizedExecutionWorkspaceFinding[];
};

export type ExecutionWorkspaceFleetRemediation = {
  version: 1;
  dryRun: false;
  companyId: string;
  requestedIssueCount: number;
  remediatedIssueCount: number;
  queuedRunCount: number;
  resolvedRecoveryActionCount: number;
  skipped: Array<{ issueId: string; issueIdentifier: string | null; reason: string }>;
  before: ExecutionWorkspaceFleetAudit;
  after: ExecutionWorkspaceFleetAudit;
};

function actionMentionsIncident(action: RecoveryActionRow, incident: ExecutionWorkspaceIncidentClass): boolean {
  const aliases = incident === "fallback_agent_home_cwd"
    ? [incident]
    : incident === "non_reusable_reuse_existing_binding" || incident === "stale_execution_workspace_binding"
      ? [incident, "workspace_not_reusable"]
      : [incident];
  if (aliases.includes(action.cause as ExecutionWorkspaceIncidentClass) || aliases.some((alias) => action.fingerprint.includes(alias))) return true;
  return action.evidenceReason !== null
    && aliases.includes(action.evidenceReason as ExecutionWorkspaceIncidentClass);
}

function resolvedStrategy(
  effectiveMode: string,
  projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>,
  issueSettings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return issueSettings?.workspaceStrategy?.type
    ?? projectPolicy?.workspaceStrategy?.type
    ?? (effectiveMode === "isolated_workspace" || effectiveMode === "operator_branch"
      ? "git_worktree"
      : effectiveMode === "agent_default"
        ? "adapter_managed"
        : "project_primary");
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function emptyIncidentCounts(): Record<ExecutionWorkspaceIncidentClass, number> {
  return {
    fallback_agent_home_cwd: 0,
    missing_project_workspace_identity: 0,
    mismatched_project_workspace_identity: 0,
    stale_execution_workspace_binding: 0,
    unrealized_isolated_workspace_request: 0,
    non_reusable_reuse_existing_binding: 0,
  };
}

/**
 * Classify one open issue without returning cwd, repository URL, branch name,
 * run output, issue text, or recovery diagnostics. The classifier deliberately
 * exposes booleans and lifecycle enums only so its result is safe to attach to
 * an issue or an operator audit.
 */
export function classifyExecutionWorkspaceRemediation(
  snapshot: ExecutionWorkspaceRemediationSnapshot,
): SanitizedExecutionWorkspaceFinding | null {
  const { issue, project, projectWorkspace, primaryProjectWorkspace, executionWorkspace } = snapshot;
  const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
  const issueSettings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings);
  const effectiveMode = resolveExecutionWorkspaceMode({
    projectPolicy,
    issueSettings,
    legacyUseProjectWorkspace: null,
  });
  const effectiveStrategy = resolvedStrategy(effectiveMode, projectPolicy, issueSettings);
  const requestedMode = issue.executionWorkspacePreference ?? issueSettings?.mode ?? projectPolicy?.defaultMode ?? null;
  const expectedProjectWorkspaceId = issue.projectWorkspaceId
    ?? projectPolicy?.defaultProjectWorkspaceId
    ?? primaryProjectWorkspace?.id
    ?? null;
  const projectWorkspaceIdentity = !issue.projectId
    ? "not_applicable" as const
    : !issue.projectWorkspaceId || !expectedProjectWorkspaceId
      ? "missing" as const
      : !projectWorkspace || projectWorkspace.projectId !== issue.projectId
        ? "mismatched" as const
        : "matching" as const;
  const pathPresent = executionWorkspace?.cwd
    ? (snapshot.pathExists ?? existsSync)(executionWorkspace.cwd)
    : null;
  const executionProjectMatches = executionWorkspace && issue.projectId
    ? executionWorkspace.projectId === issue.projectId
    : executionWorkspace
      ? false
      : null;
  const executionProjectWorkspaceMatches = executionWorkspace && expectedProjectWorkspaceId
    ? executionWorkspace.projectWorkspaceId === expectedProjectWorkspaceId
    : executionWorkspace
      ? executionWorkspace.projectWorkspaceId === null
      : null;
  const lifecycleReusable = Boolean(
    executionWorkspace
      && executionWorkspace.status === "active"
      && executionWorkspace.closedAt === null
      && pathPresent === true,
  );
  const isolatedRealized = Boolean(
    executionWorkspace
      && executionWorkspace.mode === "isolated_workspace"
      && executionWorkspace.strategyType === "git_worktree"
      && executionWorkspace.cwd
      && executionWorkspace.branchName
      && lifecycleReusable
      && executionProjectMatches === true
      && executionProjectWorkspaceMatches !== false,
  );
  const remediationPending = Boolean(
    snapshot.remediationWake
      && LIVE_WAKE_STATUSES.includes(snapshot.remediationWake.status as (typeof LIVE_WAKE_STATUSES)[number]),
  );
  const latestRunReason = snapshot.latestRun?.workspaceValidationReason ?? null;
  const fallbackAction = snapshot.activeRecoveryActions.some((action) =>
    actionMentionsIncident(action, "fallback_agent_home_cwd"));
  const fallbackOpen = !remediationPending
    && (latestRunReason === "fallback_agent_home_cwd" || fallbackAction);

  const incidents: ExecutionWorkspaceIncidentClass[] = [];
  if (fallbackOpen) incidents.push("fallback_agent_home_cwd");
  if (issue.projectId && projectWorkspaceIdentity === "missing") {
    incidents.push("missing_project_workspace_identity");
  }
  if (issue.projectId && projectWorkspaceIdentity === "mismatched") {
    incidents.push("mismatched_project_workspace_identity");
  }
  if (
    executionWorkspace
    && (
      !lifecycleReusable
      || executionProjectMatches !== true
      || executionProjectWorkspaceMatches === false
    )
  ) {
    incidents.push("stale_execution_workspace_binding");
  }
  if (
    (effectiveMode === "isolated_workspace" || effectiveMode === "operator_branch")
    && effectiveStrategy === "git_worktree"
    && !isolatedRealized
    && !remediationPending
  ) {
    incidents.push("unrealized_isolated_workspace_request");
  }
  if (
    issue.executionWorkspacePreference === "reuse_existing"
    && executionWorkspace
    && !lifecycleReusable
  ) {
    incidents.push("non_reusable_reuse_existing_binding");
  }
  if (incidents.length === 0) return null;

  const evidence = {
    issueStatus: issue.status,
    projectIdPresent: Boolean(issue.projectId),
    projectWorkspaceIdentity,
    requestedMode,
    effectiveMode,
    effectiveStrategy,
    executionWorkspace: {
      bound: Boolean(issue.executionWorkspaceId),
      mode: executionWorkspace?.mode ?? null,
      strategyType: executionWorkspace?.strategyType ?? null,
      status: executionWorkspace?.status ?? null,
      hasCwd: Boolean(executionWorkspace?.cwd),
      hasBranch: Boolean(executionWorkspace?.branchName),
      pathPresent,
      projectIdentityMatches: executionProjectMatches,
      projectWorkspaceIdentityMatches: executionProjectWorkspaceMatches,
    },
    remediationPending,
  };
  const recoveryActionIds = snapshot.activeRecoveryActions
    .filter((action) => incidents.some((incident) => actionMentionsIncident(action, incident)))
    .map((action) => action.id)
    .sort();
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    incidentClasses: [...new Set(incidents)].sort() as ExecutionWorkspaceIncidentClass[],
    fingerprint: stableFingerprint({ issueId: issue.id, incidents: [...new Set(incidents)].sort(), evidence }),
    recoveryActionIds,
    evidence,
  };
}

async function loadAuditSnapshots(
  db: DbReader,
  companyId: string,
  pathExists: (value: string) => boolean,
) {
  const issueRows = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    projectWorkspaceId: issues.projectWorkspaceId,
    status: issues.status,
    assigneeAgentId: issues.assigneeAgentId,
    responsibleUserId: issues.responsibleUserId,
    identifier: issues.identifier,
    executionWorkspaceId: issues.executionWorkspaceId,
    executionWorkspacePreference: issues.executionWorkspacePreference,
    executionWorkspaceSettings: issues.executionWorkspaceSettings,
  }).from(issues).where(and(
    eq(issues.companyId, companyId),
    inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
  ));
  if (issueRows.length === 0) return [];
  const issueIds = issueRows.map((issue) => issue.id);
  const [projectRows, projectWorkspaceRows, executionWorkspaceRows, recoveryRows, runRows, wakeRows] = await Promise.all([
    db.select({
      id: projects.id,
      companyId: projects.companyId,
      executionWorkspacePolicy: projects.executionWorkspacePolicy,
    }).from(projects).where(eq(projects.companyId, companyId)),
    db.select({
      id: projectWorkspaces.id,
      projectId: projectWorkspaces.projectId,
      isPrimary: projectWorkspaces.isPrimary,
    }).from(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId)),
    db.select({
      id: executionWorkspaces.id,
      companyId: executionWorkspaces.companyId,
      projectId: executionWorkspaces.projectId,
      projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
      mode: executionWorkspaces.mode,
      strategyType: executionWorkspaces.strategyType,
      status: executionWorkspaces.status,
      cwd: executionWorkspaces.cwd,
      branchName: executionWorkspaces.branchName,
      closedAt: executionWorkspaces.closedAt,
    }).from(executionWorkspaces).where(eq(executionWorkspaces.companyId, companyId)),
    db.select({
      id: issueRecoveryActions.id,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      status: issueRecoveryActions.status,
      cause: issueRecoveryActions.cause,
      fingerprint: issueRecoveryActions.fingerprint,
      evidenceReason: sql<string | null>`coalesce(
        ${issueRecoveryActions.evidence} ->> 'reason',
        ${issueRecoveryActions.evidence} -> 'workspaceValidation' ->> 'reason',
        ${issueRecoveryActions.evidence} -> 'resultJson' -> 'workspaceValidation' ->> 'reason'
      )`,
    }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.sourceIssueId, issueIds),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
    )),
    db.select({
      id: heartbeatRuns.id,
      issueId: sql<string | null>`coalesce(
        ${heartbeatRuns.contextSnapshot} ->> 'issueId',
        ${heartbeatRuns.contextSnapshot} ->> 'taskId'
      )`,
      workspaceValidationReason: sql<string | null>`coalesce(
        ${heartbeatRuns.resultJson} -> 'workspaceValidation' ->> 'reason',
        ${heartbeatRuns.resultJson} -> 'error' -> 'workspaceValidation' ->> 'reason'
      )`,
      createdAt: heartbeatRuns.createdAt,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(desc(heartbeatRuns.createdAt)),
    db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      createdAt: agentWakeupRequests.createdAt,
    }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      sql`${agentWakeupRequests.idempotencyKey} LIKE ${`${REMEDIATION_WAKE_PREFIX}%`}`,
      ne(agentWakeupRequests.status, "skipped"),
    )).orderBy(desc(agentWakeupRequests.createdAt)),
  ]);

  const projectsById = new Map(projectRows.map((row) => [row.id, row]));
  const projectWorkspacesById = new Map(projectWorkspaceRows.map((row) => [row.id, row]));
  const primaryByProject = new Map<string, ProjectWorkspaceRow>();
  for (const row of projectWorkspaceRows) if (row.isPrimary && !primaryByProject.has(row.projectId)) primaryByProject.set(row.projectId, row);
  const executionById = new Map(executionWorkspaceRows.map((row) => [row.id, row]));
  const recoveryByIssue = new Map<string, RecoveryActionRow[]>();
  for (const row of recoveryRows) recoveryByIssue.set(row.sourceIssueId, [...(recoveryByIssue.get(row.sourceIssueId) ?? []), row]);
  const latestRunByIssue = new Map<string, HeartbeatRunRow>();
  for (const row of runRows) {
    const issueId = row.issueId;
    if (issueId && !latestRunByIssue.has(issueId)) latestRunByIssue.set(issueId, row);
  }
  const remediationWakeByIssue = new Map<string, WakeupRow>();
  for (const row of wakeRows) {
    const issueId = row.issueId;
    if (issueId && !remediationWakeByIssue.has(issueId)) remediationWakeByIssue.set(issueId, row);
  }

  return issueRows.map((issue) => ({
    issue,
    project: issue.projectId ? projectsById.get(issue.projectId) ?? null : null,
    projectWorkspace: issue.projectWorkspaceId ? projectWorkspacesById.get(issue.projectWorkspaceId) ?? null : null,
    primaryProjectWorkspace: issue.projectId ? primaryByProject.get(issue.projectId) ?? null : null,
    executionWorkspace: issue.executionWorkspaceId ? executionById.get(issue.executionWorkspaceId) ?? null : null,
    activeRecoveryActions: recoveryByIssue.get(issue.id) ?? [],
    latestRun: latestRunByIssue.get(issue.id) ?? null,
    remediationWake: remediationWakeByIssue.get(issue.id) ?? null,
    pathExists,
  } satisfies ExecutionWorkspaceRemediationSnapshot));
}

export async function auditExecutionWorkspaceFleet(
  db: Db,
  input: { companyId: string; now?: Date; pathExists?: (value: string) => boolean },
): Promise<ExecutionWorkspaceFleetAudit> {
  const snapshots = await loadAuditSnapshots(db, input.companyId, input.pathExists ?? existsSync);
  const findings = snapshots
    .map(classifyExecutionWorkspaceRemediation)
    .filter((finding): finding is SanitizedExecutionWorkspaceFinding => Boolean(finding))
    .sort((a, b) => (a.issueIdentifier ?? a.issueId).localeCompare(b.issueIdentifier ?? b.issueId));
  const incidentCounts = emptyIncidentCounts();
  for (const finding of findings) for (const incident of finding.incidentClasses) incidentCounts[incident] += 1;
  return {
    version: 1,
    dryRun: true,
    generatedAt: (input.now ?? new Date()).toISOString(),
    companyId: input.companyId,
    checkedIssueCount: snapshots.length,
    findingCount: findings.length,
    incidentCounts,
    findings,
  };
}

export async function remediateExecutionWorkspaceFleet(
  db: Db,
  input: {
    companyId: string;
    issueRefs: string[];
    actorId?: string;
    now?: Date;
    pathExists?: (value: string) => boolean;
  },
): Promise<ExecutionWorkspaceFleetRemediation> {
  const issueRefs = [...new Set(input.issueRefs.map((value) => value.trim()).filter(Boolean))];
  if (issueRefs.length === 0) throw new Error("Apply requires at least one explicitly selected issue id or identifier.");
  const now = input.now ?? new Date();
  const before = await auditExecutionWorkspaceFleet(db, {
    companyId: input.companyId,
    now,
    pathExists: input.pathExists,
  });
  const selected = before.findings.filter((finding) =>
    issueRefs.includes(finding.issueId) || (finding.issueIdentifier ? issueRefs.includes(finding.issueIdentifier) : false));
  const selectedRefSet = new Set(selected.flatMap((finding) => [finding.issueId, finding.issueIdentifier].filter(Boolean) as string[]));
  const skipped: ExecutionWorkspaceFleetRemediation["skipped"] = issueRefs
    .filter((ref) => !selectedRefSet.has(ref))
    .map((ref) => ({ issueId: ref, issueIdentifier: null, reason: "no_open_supported_incident" }));
  let queuedRunCount = 0;
  let resolvedRecoveryActionCount = 0;
  let remediatedIssueCount = 0;

  for (const finding of selected) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM issues WHERE id = ${finding.issueId} AND company_id = ${input.companyId} FOR UPDATE`);
      const lockedIssue = await tx.select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        projectWorkspaceId: issues.projectWorkspaceId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        responsibleUserId: issues.responsibleUserId,
        identifier: issues.identifier,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      }).from(issues).where(and(
        eq(issues.id, finding.issueId),
        eq(issues.companyId, input.companyId),
        inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (!lockedIssue) return { kind: "skip" as const, reason: "issue_no_longer_open" };
      if (!lockedIssue.assigneeAgentId) return { kind: "skip" as const, reason: "issue_has_no_agent_assignee" };

      // The dry-run report is a proposal, not authority to clear whatever a
      // later writer may have bound. Reclassify under the issue row lock and
      // require the same sanitized state fingerprint before mutation.
      const currentFinding = (await loadAuditSnapshots(
        tx,
        input.companyId,
        input.pathExists ?? existsSync,
      ))
        .map(classifyExecutionWorkspaceRemediation)
        .find((candidate) => candidate?.issueId === lockedIssue.id) ?? null;
      if (!currentFinding || currentFinding.fingerprint !== finding.fingerprint) {
        return { kind: "skip" as const, reason: "incident_changed_since_audit" };
      }

      const activeRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, lockedIssue.assigneeAgentId),
        inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
        sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId') = ${lockedIssue.id}`,
      )).limit(1).then((rows) => rows[0] ?? null);
      const liveWake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, lockedIssue.assigneeAgentId),
        inArray(agentWakeupRequests.status, [...LIVE_WAKE_STATUSES]),
        sql`coalesce(${agentWakeupRequests.payload} ->> 'issueId', ${agentWakeupRequests.payload} ->> 'taskId') = ${lockedIssue.id}`,
      )).limit(1).then((rows) => rows[0] ?? null);
      if (activeRun || liveWake) return { kind: "skip" as const, reason: "issue_already_has_live_execution" };

      const idempotencyKey = `${REMEDIATION_WAKE_PREFIX}${lockedIssue.id}:${currentFinding.fingerprint}`;
      const priorWake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ne(agentWakeupRequests.status, "skipped"),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (priorWake) return { kind: "skip" as const, reason: "remediation_already_queued" };

      await tx.update(issues).set({ executionWorkspaceId: null, updatedAt: now }).where(eq(issues.id, lockedIssue.id));
      const resolvedActions = currentFinding.recoveryActionIds.length === 0
        ? []
        : await tx.update(issueRecoveryActions).set({
            status: "resolved",
            outcome: "restored",
            resolutionNote: "Invalid execution-workspace binding cleared by approved fleet remediation; one fresh run was queued.",
            wakePolicy: null,
            monitorPolicy: null,
            resolvedAt: now,
            updatedAt: now,
          }).where(and(
            eq(issueRecoveryActions.companyId, input.companyId),
            inArray(issueRecoveryActions.id, currentFinding.recoveryActionIds),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
          )).returning({ id: issueRecoveryActions.id });

      const safeContext = {
        issueId: lockedIssue.id,
        taskId: lockedIssue.id,
        taskKey: lockedIssue.identifier ?? lockedIssue.id,
        projectId: lockedIssue.projectId,
        wakeReason: "execution_workspace_fleet_remediation",
        workspaceRemediation: {
          version: 1,
          fingerprint: currentFinding.fingerprint,
          incidentClasses: currentFinding.incidentClasses,
        },
      };
      const wake = await tx.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: lockedIssue.assigneeAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "execution_workspace_fleet_remediation",
        payload: safeContext,
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: input.actorId ?? "execution_workspace_remediation_cli",
        idempotencyKey,
        requestedAt: now,
        updatedAt: now,
      }).returning().then((rows) => rows[0]!);
      const run = await tx.insert(heartbeatRuns).values({
        companyId: input.companyId,
        agentId: lockedIssue.assigneeAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        responsibleUserId: lockedIssue.responsibleUserId,
        wakeupRequestId: wake.id,
        scheduledRetryAt: now,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "execution_workspace_fleet_remediation",
        contextSnapshot: safeContext,
        updatedAt: now,
      }).returning().then((rows) => rows[0]!);
      await tx.update(agentWakeupRequests).set({ runId: run.id, updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: input.actorId ?? "execution_workspace_remediation_cli",
        action: "execution_workspace.fleet_remediated",
        entityType: "issue",
        entityId: lockedIssue.id,
        responsibleUserId: lockedIssue.responsibleUserId,
        details: {
          version: 1,
          incidentClasses: currentFinding.incidentClasses,
          fingerprint: currentFinding.fingerprint,
          clearedExecutionWorkspaceBinding: Boolean(lockedIssue.executionWorkspaceId),
          preservedProjectWorkspaceId: Boolean(lockedIssue.projectWorkspaceId),
          preservedIssueWorkspacePolicy: Boolean(lockedIssue.executionWorkspaceSettings),
          queuedRunId: run.id,
          resolvedRecoveryActionCount: resolvedActions.length,
        },
      });
      return { kind: "remediated" as const, resolvedActions: resolvedActions.length };
    });

    if (result.kind === "skip") {
      skipped.push({ issueId: finding.issueId, issueIdentifier: finding.issueIdentifier, reason: result.reason });
      continue;
    }
    remediatedIssueCount += 1;
    queuedRunCount += 1;
    resolvedRecoveryActionCount += result.resolvedActions;
  }

  const after = await auditExecutionWorkspaceFleet(db, {
    companyId: input.companyId,
    now,
    pathExists: input.pathExists,
  });
  return {
    version: 1,
    dryRun: false,
    companyId: input.companyId,
    requestedIssueCount: issueRefs.length,
    remediatedIssueCount,
    queuedRunCount,
    resolvedRecoveryActionCount,
    skipped,
    before,
    after,
  };
}

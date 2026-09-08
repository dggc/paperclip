import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
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
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceDeliveryState,
} from "@paperclipai/shared";
import {
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { evaluateExecutionWorkspaceReuseCompatibility } from "./heartbeat.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const LIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
const ACTIVE_RECOVERY_STATUSES = ["active", "escalated"] as const;
const REMEDIATION_WAKE_PREFIX = "execution-workspace-remediation:";
const REMEDIATION_PENDING_LEASE_MS = 5 * 60 * 1_000;

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
type ProjectWorkspaceRow = Pick<typeof projectWorkspaces.$inferSelect, "id" | "projectId" | "cwd" | "isPrimary">;
type ExecutionWorkspaceRow = Pick<typeof executionWorkspaces.$inferSelect,
  | "id" | "companyId" | "projectId" | "projectWorkspaceId" | "sourceIssueId"
  | "mode" | "strategyType" | "name" | "status" | "cwd" | "repoUrl" | "baseRef"
  | "branchName" | "providerType" | "providerRef" | "derivedFromExecutionWorkspaceId"
  | "lastUsedAt" | "openedAt" | "closedAt" | "cleanupEligibleAt" | "cleanupReason"
  | "metadata" | "createdAt" | "updatedAt"
> & { deliveryState: ExecutionWorkspaceDeliveryState };
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
  reuseCompatibility?: { reusable: boolean; reason: string | null };
  evaluatedAt?: Date;
};

export type QueueExecutionWorkspaceRemediationWake = (input: {
  agentId: string;
  issueId: string;
  projectId: string | null;
  issueIdentifier: string | null;
  fingerprint: string;
  incidentClasses: ExecutionWorkspaceIncidentClass[];
  idempotencyKey: string;
  actorId: string;
}) => Promise<{ id: string } | null>;

export type SanitizedExecutionWorkspaceFinding = {
  issueId: string;
  issueIdentifier: string | null;
  incidentClasses: ExecutionWorkspaceIncidentClass[];
  fingerprint: string;
  recoveryActionIds: string[];
  evidence: {
    issueStatus: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "invalid";
    projectIdPresent: boolean;
    projectWorkspaceIdentity: "not_applicable" | "missing" | "matching" | "mismatched";
    requestedMode: "inherit" | "shared_workspace" | "isolated_workspace" | "operator_branch" | "reuse_existing" | "agent_default" | "invalid" | null;
    effectiveMode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "agent_default";
    effectiveStrategy: "project_primary" | "git_worktree" | "adapter_managed" | "cloud_sandbox";
    executionWorkspace: {
      bound: boolean;
      mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox" | "invalid" | null;
      strategyType: "project_primary" | "git_worktree" | "adapter_managed" | "cloud_sandbox" | "invalid" | null;
      providerType: "local_fs" | "git_worktree" | "adapter_managed" | "cloud_sandbox" | "invalid" | null;
      status: "active" | "idle" | "in_review" | "archived" | "cleanup_failed" | "invalid" | null;
      deliveryState: ExecutionWorkspaceDeliveryState;
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
  skipped: Array<{ issueId: string | null; issueIdentifier: string | null; reason: string }>;
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
  effectiveMode: ReturnType<typeof resolveExecutionWorkspaceMode>,
  projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>,
  issueSettings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return resolveEffectiveWorkspaceStrategyType(effectiveMode, {
    workspaceStrategy:
      issueSettings?.workspaceStrategy ?? projectPolicy?.workspaceStrategy ?? null,
  });
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

const SAFE_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const SAFE_REQUESTED_MODES = new Set([
  "inherit", "shared_workspace", "isolated_workspace", "operator_branch", "reuse_existing", "agent_default",
]);
const SAFE_WORKSPACE_MODES = new Set([
  "shared_workspace", "isolated_workspace", "operator_branch", "adapter_managed", "cloud_sandbox",
]);
const SAFE_STRATEGY_TYPES = new Set(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]);
const SAFE_PROVIDER_TYPES = new Set(["local_fs", "git_worktree", "adapter_managed", "cloud_sandbox"]);
const SAFE_WORKSPACE_STATUSES = new Set(["active", "idle", "in_review", "archived", "cleanup_failed"]);
const SAFE_ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,11}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowlisted<T extends string>(value: string | null | undefined, allowed: Set<string>): T | "invalid" | null {
  if (value == null) return null;
  return allowed.has(value) ? value as T : "invalid";
}

function sanitizedIssueIdentifier(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return SAFE_ISSUE_IDENTIFIER.test(normalized) ? normalized : null;
}

function normalizeIssueRef(value: string) {
  const trimmed = value.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  const identifier = trimmed.toUpperCase();
  return SAFE_ISSUE_IDENTIFIER.test(identifier) ? identifier : null;
}

function toCompatibilityWorkspace(row: ExecutionWorkspaceRow): ExecutionWorkspace {
  return {
    ...row,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    status: row.status as ExecutionWorkspace["status"],
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    config: null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  };
}

/**
 * Classify one open issue without returning cwd, repository URL, branch name,
 * run output, issue text, or recovery diagnostics. The classifier deliberately
 * exposes booleans and lifecycle enums only so its result is safe to attach to
 * an issue or an operator audit.
 */
export async function classifyExecutionWorkspaceRemediation(
  snapshot: ExecutionWorkspaceRemediationSnapshot,
): Promise<SanitizedExecutionWorkspaceFinding | null> {
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
  const executionPath = executionWorkspace?.providerRef ?? executionWorkspace?.cwd ?? null;
  const pathPresent = executionPath
    ? (snapshot.pathExists ?? existsSync)(executionPath)
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
  const requestedBranchName = issueSettings?.workspaceStrategy?.existingBranch
    ?? projectPolicy?.workspaceStrategy?.existingBranch
    ?? null;
  const reuseCompatibility = executionWorkspace
    ? snapshot.reuseCompatibility ?? await evaluateExecutionWorkspaceReuseCompatibility({
        workspace: toCompatibilityWorkspace(executionWorkspace),
        expectedCompanyId: issue.companyId,
        expectedProjectId: issue.projectId,
        expectedProjectWorkspaceId,
        requestedExecutionWorkspaceMode: effectiveMode,
        requestedBranchName,
        expectedRepoRoot: projectWorkspace?.cwd ?? primaryProjectWorkspace?.cwd ?? null,
        inspectFilesystem: true,
      })
    : { reusable: false, reason: "workspace_missing" };
  const lifecycleReusable = Boolean(reuseCompatibility.reusable && pathPresent === true);
  const remediationWakeStatus = snapshot.remediationWake?.status ?? null;
  const pendingReservationIsLive = remediationWakeStatus === "remediation_pending"
    && Boolean(snapshot.remediationWake?.createdAt)
    && snapshot.remediationWake!.createdAt.getTime()
      >= (snapshot.evaluatedAt ?? new Date()).getTime() - REMEDIATION_PENDING_LEASE_MS;
  const remediationPending = pendingReservationIsLive || Boolean(
    remediationWakeStatus
      && LIVE_WAKE_STATUSES.includes(remediationWakeStatus as (typeof LIVE_WAKE_STATUSES)[number]),
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
    issue.executionWorkspaceId
    && (
      !executionWorkspace
      || !lifecycleReusable
      || executionProjectMatches !== true
      || executionProjectWorkspaceMatches === false
    )
  ) {
    incidents.push("stale_execution_workspace_binding");
  }
  if (
    effectiveMode === "isolated_workspace"
    && !lifecycleReusable
    && !remediationPending
  ) {
    incidents.push("unrealized_isolated_workspace_request");
  }
  if (
    issue.executionWorkspacePreference === "reuse_existing"
    && issue.executionWorkspaceId
    && !lifecycleReusable
  ) {
    incidents.push("non_reusable_reuse_existing_binding");
  }
  if (incidents.length === 0) return null;

  const evidence: SanitizedExecutionWorkspaceFinding["evidence"] = {
    issueStatus: (allowlisted(issue.status, SAFE_ISSUE_STATUSES) ?? "invalid") as SanitizedExecutionWorkspaceFinding["evidence"]["issueStatus"],
    projectIdPresent: Boolean(issue.projectId),
    projectWorkspaceIdentity,
    requestedMode: allowlisted(requestedMode, SAFE_REQUESTED_MODES) as SanitizedExecutionWorkspaceFinding["evidence"]["requestedMode"],
    effectiveMode,
    effectiveStrategy,
    executionWorkspace: {
      bound: Boolean(issue.executionWorkspaceId),
      mode: allowlisted(executionWorkspace?.mode, SAFE_WORKSPACE_MODES),
      strategyType: allowlisted(executionWorkspace?.strategyType, SAFE_STRATEGY_TYPES),
      providerType: allowlisted(executionWorkspace?.providerType, SAFE_PROVIDER_TYPES),
      status: allowlisted(executionWorkspace?.status, SAFE_WORKSPACE_STATUSES),
      deliveryState: executionWorkspace?.deliveryState ?? "unknown",
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
    issueIdentifier: sanitizedIssueIdentifier(issue.identifier),
    incidentClasses: [...new Set(incidents)].sort() as ExecutionWorkspaceIncidentClass[],
    fingerprint: stableFingerprint({
      issueId: issue.id,
      incidents: [...new Set(incidents)].sort(),
      evidence,
      stateIdentity: stableFingerprint({
        executionWorkspaceId: issue.executionWorkspaceId,
        executionWorkspaceUpdatedAt: executionWorkspace?.updatedAt?.toISOString() ?? null,
        lifecycleGeneration:
          executionWorkspace?.metadata && typeof executionWorkspace.metadata.lifecycleGeneration === "number"
            ? executionWorkspace.metadata.lifecycleGeneration
            : null,
        recoveryActions: snapshot.activeRecoveryActions.map((action) => ({
          id: action.id,
          status: action.status,
          fingerprint: action.fingerprint,
        })).sort((a, b) => a.id.localeCompare(b.id)),
      }),
    }),
    recoveryActionIds,
    evidence,
  };
}

async function loadAuditSnapshots(
  db: DbReader,
  companyId: string,
  pathExists: (value: string) => boolean,
  evaluatedAt: Date,
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
      cwd: projectWorkspaces.cwd,
      isPrimary: projectWorkspaces.isPrimary,
    }).from(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId)),
    db.select({
      id: executionWorkspaces.id,
      companyId: executionWorkspaces.companyId,
      projectId: executionWorkspaces.projectId,
      projectWorkspaceId: executionWorkspaces.projectWorkspaceId,
      sourceIssueId: executionWorkspaces.sourceIssueId,
      mode: executionWorkspaces.mode,
      strategyType: executionWorkspaces.strategyType,
      name: executionWorkspaces.name,
      status: executionWorkspaces.status,
      cwd: executionWorkspaces.cwd,
      repoUrl: executionWorkspaces.repoUrl,
      baseRef: executionWorkspaces.baseRef,
      branchName: executionWorkspaces.branchName,
      providerType: executionWorkspaces.providerType,
      providerRef: executionWorkspaces.providerRef,
      derivedFromExecutionWorkspaceId: executionWorkspaces.derivedFromExecutionWorkspaceId,
      lastUsedAt: executionWorkspaces.lastUsedAt,
      openedAt: executionWorkspaces.openedAt,
      closedAt: executionWorkspaces.closedAt,
      cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
      cleanupReason: executionWorkspaces.cleanupReason,
      metadata: executionWorkspaces.metadata,
      createdAt: executionWorkspaces.createdAt,
      updatedAt: executionWorkspaces.updatedAt,
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
      issueId: sql<string | null>`coalesce(
        ${agentWakeupRequests.payload} ->> 'issueId',
        ${agentWakeupRequests.payload} ->> 'taskId',
        ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
        ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
      )`,
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
  const deliveryStateById = new Map<string, ExecutionWorkspaceDeliveryState>();
  const deliveryAssessor = executionWorkspaceService(db as Db);
  await Promise.all(executionWorkspaceRows.map(async (row) => {
    const state = await deliveryAssessor.assessDeliveryStateById(row.id).catch(() => "unknown" as const);
    deliveryStateById.set(row.id, state ?? "unknown");
  }));
  const executionById = new Map(executionWorkspaceRows.map((row) => [
    row.id,
    { ...row, deliveryState: deliveryStateById.get(row.id) ?? "unknown" },
  ]));
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
    evaluatedAt,
  } satisfies ExecutionWorkspaceRemediationSnapshot));
}

export async function auditExecutionWorkspaceFleet(
  db: Db,
  input: { companyId: string; now?: Date; pathExists?: (value: string) => boolean },
): Promise<ExecutionWorkspaceFleetAudit> {
  const evaluatedAt = input.now ?? new Date();
  const snapshots = await loadAuditSnapshots(
    db,
    input.companyId,
    input.pathExists ?? existsSync,
    evaluatedAt,
  );
  const findings = (await Promise.all(snapshots.map(classifyExecutionWorkspaceRemediation)))
    .filter((finding): finding is SanitizedExecutionWorkspaceFinding => Boolean(finding))
    .sort((a, b) => (a.issueIdentifier ?? a.issueId).localeCompare(b.issueIdentifier ?? b.issueId));
  const incidentCounts = emptyIncidentCounts();
  for (const finding of findings) for (const incident of finding.incidentClasses) incidentCounts[incident] += 1;
  return {
    version: 1,
    dryRun: true,
    generatedAt: evaluatedAt.toISOString(),
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
    queueWakeup: QueueExecutionWorkspaceRemediationWake;
  },
): Promise<ExecutionWorkspaceFleetRemediation> {
  const normalizedRefs = input.issueRefs.map(normalizeIssueRef);
  const issueRefs = [...new Set(normalizedRefs.filter((value): value is string => Boolean(value)))];
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
  const skipped: ExecutionWorkspaceFleetRemediation["skipped"] = normalizedRefs
    .filter((ref): ref is null => ref === null)
    .map(() => ({ issueId: null, issueIdentifier: null, reason: "invalid_issue_reference" }));
  skipped.push(...issueRefs
    .filter((ref) => !selectedRefSet.has(ref))
    .map((ref) => ({
      issueId: UUID.test(ref) ? ref : null,
      issueIdentifier: SAFE_ISSUE_IDENTIFIER.test(ref) ? ref : null,
      reason: "no_open_supported_incident",
    })));
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
      const currentFindings = await Promise.all(
        (await loadAuditSnapshots(
          tx,
          input.companyId,
          input.pathExists ?? existsSync,
          now,
        )).map(classifyExecutionWorkspaceRemediation),
      );
      const currentFinding = currentFindings
        .find((candidate) => candidate?.issueId === lockedIssue.id) ?? null;
      if (!currentFinding || currentFinding.fingerprint !== finding.fingerprint) {
        return { kind: "skip" as const, reason: "incident_changed_since_audit" };
      }

      const activeRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, lockedIssue.assigneeAgentId),
        inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
        sql`coalesce(
          ${heartbeatRuns.contextSnapshot} ->> 'issueId',
          ${heartbeatRuns.contextSnapshot} ->> 'taskId',
          ${heartbeatRuns.contextSnapshot} -> '_paperclipWakeContext' ->> 'issueId',
          ${heartbeatRuns.contextSnapshot} -> '_paperclipWakeContext' ->> 'taskId'
        ) = ${lockedIssue.id}`,
      )).limit(1).then((rows) => rows[0] ?? null);
      await tx.delete(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, lockedIssue.assigneeAgentId),
        eq(agentWakeupRequests.status, "remediation_pending"),
        lt(agentWakeupRequests.createdAt, new Date(now.getTime() - REMEDIATION_PENDING_LEASE_MS)),
        sql`coalesce(
          ${agentWakeupRequests.payload} ->> 'issueId',
          ${agentWakeupRequests.payload} ->> 'taskId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
        ) = ${lockedIssue.id}`,
      ));
      const liveWake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, lockedIssue.assigneeAgentId),
        inArray(agentWakeupRequests.status, [...LIVE_WAKE_STATUSES]),
        sql`coalesce(
          ${agentWakeupRequests.payload} ->> 'issueId',
          ${agentWakeupRequests.payload} ->> 'taskId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
          ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
        ) = ${lockedIssue.id}`,
      )).limit(1).then((rows) => rows[0] ?? null);
      if (activeRun || liveWake) return { kind: "skip" as const, reason: "issue_already_has_live_execution" };

      const idempotencyKey = `${REMEDIATION_WAKE_PREFIX}${lockedIssue.id}:${currentFinding.fingerprint}`;
      const priorWake = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ne(agentWakeupRequests.status, "skipped"),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (priorWake) return { kind: "skip" as const, reason: "remediation_already_queued" };

      // Reserve the remediation in the same transaction that clears the stale
      // binding. heartbeat.wakeup adopts this marker while holding the same
      // issue lock, so a fresh audit cannot slip into the clear-to-queue gap.
      await tx.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: lockedIssue.assigneeAgentId,
        source: "manual",
        triggerDetail: "execution_workspace_fleet_remediation",
        reason: "execution_workspace_remediation_pending",
        payload: {
          issueId: lockedIssue.id,
          incidentClasses: currentFinding.incidentClasses,
          fingerprint: currentFinding.fingerprint,
        },
        status: "remediation_pending",
        requestedByActorType: "automation",
        requestedByActorId: input.actorId ?? "execution_workspace_remediation_cli",
        idempotencyKey,
        requestedAt: now,
      });
      await tx.update(issues).set({ executionWorkspaceId: null, updatedAt: now }).where(eq(issues.id, lockedIssue.id));
      return {
        kind: "cleared" as const,
        agentId: lockedIssue.assigneeAgentId,
        projectId: lockedIssue.projectId,
        issueIdentifier: sanitizedIssueIdentifier(lockedIssue.identifier),
        responsibleUserId: lockedIssue.responsibleUserId,
        projectWorkspacePreserved: Boolean(lockedIssue.projectWorkspaceId),
        issueWorkspacePolicyPreserved: Boolean(lockedIssue.executionWorkspaceSettings),
        recoveryActionIds: currentFinding.recoveryActionIds,
        fingerprint: currentFinding.fingerprint,
        incidentClasses: currentFinding.incidentClasses,
        idempotencyKey,
      };
    });

    if (result.kind === "skip") {
      skipped.push({ issueId: finding.issueId, issueIdentifier: finding.issueIdentifier, reason: result.reason });
      continue;
    }
    remediatedIssueCount += 1;
    const queuedRun = await input.queueWakeup({
      agentId: result.agentId,
      issueId: finding.issueId,
      projectId: result.projectId,
      issueIdentifier: result.issueIdentifier,
      fingerprint: result.fingerprint,
      incidentClasses: result.incidentClasses,
      idempotencyKey: result.idempotencyKey,
      actorId: input.actorId ?? "execution_workspace_remediation_cli",
    }).catch(() => null);
    if (!queuedRun) {
      await db.delete(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, result.idempotencyKey),
        eq(agentWakeupRequests.status, "remediation_pending"),
      ));
      skipped.push({
        issueId: finding.issueId,
        issueIdentifier: finding.issueIdentifier,
        reason: "wake_not_queued",
      });
      continue;
    }
    queuedRunCount += 1;
    const resolvedActions = result.recoveryActionIds.length === 0
      ? []
      : await db.update(issueRecoveryActions).set({
          status: "resolved",
          outcome: "restored",
          resolutionNote: "Invalid execution-workspace binding cleared by approved fleet remediation; one fresh run was queued.",
          wakePolicy: null,
          monitorPolicy: null,
          resolvedAt: now,
          updatedAt: now,
        }).where(and(
          eq(issueRecoveryActions.companyId, input.companyId),
          inArray(issueRecoveryActions.id, result.recoveryActionIds),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_STATUSES]),
        )).returning({ id: issueRecoveryActions.id });
    resolvedRecoveryActionCount += resolvedActions.length;
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: input.actorId ?? "execution_workspace_remediation_cli",
      action: "execution_workspace.fleet_remediated",
      entityType: "issue",
      entityId: finding.issueId,
      responsibleUserId: result.responsibleUserId,
      details: {
        version: 1,
        incidentClasses: result.incidentClasses,
        fingerprint: result.fingerprint,
        clearedExecutionWorkspaceBinding: true,
        preservedProjectWorkspaceId: result.projectWorkspacePreserved,
        preservedIssueWorkspacePolicy: result.issueWorkspacePolicyPreserved,
        queuedRunId: queuedRun.id,
        resolvedRecoveryActionCount: resolvedActions.length,
      },
    });
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

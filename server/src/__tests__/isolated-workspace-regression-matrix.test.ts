import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { projectExecutionWorkspacePolicySchema } from "@paperclipai/shared";
import {
  auditExecutionWorkspaceFleet,
  classifyExecutionWorkspaceRemediation,
  remediateExecutionWorkspaceFleet,
  type ExecutionWorkspaceRemediationSnapshot,
} from "../services/execution-workspace-remediation.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const now = new Date("2026-09-08T12:00:00.000Z");

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    goalId: null,
    parentId: null,
    title: "Synthetic issue",
    description: null,
    status: "todo",
    statusVersion: 0,
    lastStatusDecisionId: null,
    workMode: "standard",
    harnessKind: null,
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: "user-1",
    issueNumber: 1,
    identifier: "SYN-1",
    originKind: "manual",
    originId: null,
    originRunId: null,
    originIdentityContextId: null,
    continuationIdentityContextId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    executionWorkspaceId: "execution-workspace-1",
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    sourceTrust: null,
    unblockDescriptor: null,
    blockedTransitionAt: null,
    blockedOwnerNotifiedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof issues.$inferSelect;
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    goalId: null,
    name: "Synthetic project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: {
      enabled: true,
      defaultMode: "isolated_workspace",
      defaultProjectWorkspaceId: "project-workspace-1",
      workspaceStrategy: { type: "git_worktree" },
    },
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof projects.$inferSelect;
}

function projectWorkspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary",
    sourceType: "local_path",
    cwd: "/private/repository/main",
    repoUrl: "ssh://private.example/repository.git",
    repoRef: null,
    defaultRef: "main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof projectWorkspaces.$inferSelect;
}

function executionWorkspaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Synthetic isolated workspace",
    status: "active",
    cwd: "/private/repository/worktree",
    repoUrl: "ssh://private.example/repository.git",
    baseRef: "main",
    branchName: "SYN-1",
    providerType: "local_fs",
    providerRef: "/private/repository/worktree",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: { privateContent: "must-not-leak" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as typeof executionWorkspaces.$inferSelect;
}

function snapshot(overrides: Partial<ExecutionWorkspaceRemediationSnapshot> = {}): ExecutionWorkspaceRemediationSnapshot {
  const workspace = projectWorkspaceRow();
  return {
    issue: issueRow(),
    project: projectRow(),
    projectWorkspace: workspace,
    primaryProjectWorkspace: workspace,
    executionWorkspace: executionWorkspaceRow(),
    activeRecoveryActions: [],
    latestRun: null,
    remediationWake: null,
    pathExists: () => true,
    ...overrides,
  };
}

describe("isolated workspace nine-scenario regression matrix", () => {
  it("1. accepts a project-default isolated git worktree realization", () => {
    expect(classifyExecutionWorkspaceRemediation(snapshot())).toBeNull();
  });

  it("2. rejects an incoherent adapter_default plus git_worktree project policy", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      defaultMode: "adapter_default",
      workspaceStrategy: { type: "git_worktree" },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected policy rejection");
    expect(result.error.issues[0]?.params).toMatchObject({
      paperclipCode: "incoherent_execution_workspace_policy",
      recommendedAction: { patch: { defaultMode: "isolated_workspace" } },
    });
  });

  it("3. accepts an issue-level isolated override over a shared project default", () => {
    expect(classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspaceSettings: { mode: "isolated_workspace" } }),
      project: projectRow({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: "project-workspace-1",
        },
      }),
    }))).toBeNull();
  });

  it("4. accepts active compatible reuse", () => {
    expect(classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
    }))).toBeNull();
  });

  it("5. reports archived or missing reuse as non-reusable", () => {
    const archived = classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
      executionWorkspace: executionWorkspaceRow({ status: "archived", closedAt: now }),
    }));
    expect(archived?.incidentClasses).toEqual(expect.arrayContaining([
      "stale_execution_workspace_binding",
      "non_reusable_reuse_existing_binding",
    ]));

    const missing = classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
      executionWorkspace: executionWorkspaceRow(),
      pathExists: () => false,
    }));
    expect(missing?.incidentClasses).toContain("non_reusable_reuse_existing_binding");
  });

  it("6. preserves matching project workspace identity across parent and child snapshots", () => {
    const parent = snapshot({ issue: issueRow({ id: "parent", identifier: "SYN-6" }) });
    const child = snapshot({ issue: issueRow({ id: "child", identifier: "SYN-7", parentId: "parent" }) });
    expect(parent.issue.projectWorkspaceId).toBe(child.issue.projectWorkspaceId);
    expect(classifyExecutionWorkspaceRemediation(parent)).toBeNull();
    expect(classifyExecutionWorkspaceRemediation(child)).toBeNull();
  });

  it("7. accepts distinct compatible worktrees for sibling issues", () => {
    const siblingA = snapshot({
      issue: issueRow({ id: "sibling-a", identifier: "SYN-8", executionWorkspaceId: "workspace-a" }),
      executionWorkspace: executionWorkspaceRow({ id: "workspace-a", sourceIssueId: "sibling-a", branchName: "SYN-8" }),
    });
    const siblingB = snapshot({
      issue: issueRow({ id: "sibling-b", identifier: "SYN-9", executionWorkspaceId: "workspace-b" }),
      executionWorkspace: executionWorkspaceRow({ id: "workspace-b", sourceIssueId: "sibling-b", branchName: "SYN-9" }),
    });
    expect(siblingA.executionWorkspace?.id).not.toBe(siblingB.executionWorkspace?.id);
    expect(classifyExecutionWorkspaceRemediation(siblingA)).toBeNull();
    expect(classifyExecutionWorkspaceRemediation(siblingB)).toBeNull();
  });

  it("9. emits sanitized evidence with no paths, repository URLs, names, or private content", () => {
    const finding = classifyExecutionWorkspaceRemediation(snapshot({
      executionWorkspace: executionWorkspaceRow({ status: "archived", closedAt: now }),
    }));
    const encoded = JSON.stringify(finding);
    expect(encoded).not.toContain("/private/");
    expect(encoded).not.toContain("private.example");
    expect(encoded).not.toContain("must-not-leak");
    expect(encoded).not.toContain("Synthetic issue");
    expect(encoded).not.toContain("SYN-1-isolated");
  });
});

describe("fleet audit incident coverage", () => {
  it("classifies every supported incident class using sanitized synthetic metadata", () => {
    const mismatchedProjectWorkspace = projectWorkspaceRow({ projectId: "other-project" });
    const activeFallbackRecovery = {
      id: "recovery-1",
      sourceIssueId: "issue-1",
      status: "active",
      cause: "fallback_agent_home_cwd",
      fingerprint: "fallback_agent_home_cwd:synthetic",
      evidenceReason: "fallback_agent_home_cwd",
    } as ExecutionWorkspaceRemediationSnapshot["activeRecoveryActions"][number];
    const finding = classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({
        projectWorkspaceId: "project-workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      }),
      projectWorkspace: mismatchedProjectWorkspace,
      executionWorkspace: executionWorkspaceRow({
        projectId: "other-project",
        projectWorkspaceId: "other-project-workspace",
        status: "archived",
        closedAt: now,
      }),
      activeRecoveryActions: [activeFallbackRecovery],
      pathExists: () => false,
    }));

    expect(finding?.incidentClasses).toEqual(expect.arrayContaining([
      "fallback_agent_home_cwd",
      "mismatched_project_workspace_identity",
      "stale_execution_workspace_binding",
      "unrealized_isolated_workspace_request",
      "non_reusable_reuse_existing_binding",
    ]));
    const missing = classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ projectWorkspaceId: null }),
      projectWorkspace: null,
      executionWorkspace: null,
    }));
    expect(missing?.incidentClasses).toContain("missing_project_workspace_identity");
    expect(JSON.stringify([finding, missing])).not.toContain("/private/");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("8. fleet remediation is idempotent", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-remediation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("8. clears only the invalid binding, resolves recovery, and queues one fresh run across repeated apply", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const recoveryActionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic remediation company",
      issuePrefix: `WR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthetic agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Synthetic project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        defaultProjectWorkspaceId: projectWorkspaceId,
        workspaceStrategy: { type: "git_worktree" },
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/synthetic/base",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Synthetic stale reuse",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "user-1",
      issueNumber: 1,
      identifier: "SYN-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "reuse_existing" },
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Archived worktree",
      status: "archived",
      cwd: "/synthetic/stale-worktree",
      branchName: "SYN-1",
      closedAt: now,
    });
    await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "workspace_not_reusable",
      fingerprint: "workspace_not_reusable:synthetic",
      evidence: { workspaceValidation: { reason: "workspace_not_reusable", path: "/must/not/leak" } },
      nextAction: "Create a fresh isolated workspace.",
    });

    const dryRun = await auditExecutionWorkspaceFleet(db, { companyId, pathExists: () => false, now });
    expect(dryRun.incidentCounts.non_reusable_reuse_existing_binding).toBe(1);
    expect(JSON.stringify(dryRun)).not.toContain("/synthetic/");
    expect(JSON.stringify(dryRun)).not.toContain("/must/not/leak");

    const first = await remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["SYN-1"],
      pathExists: () => false,
      now,
    });
    const second = await remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["SYN-1"],
      pathExists: () => false,
      now,
    });

    expect(first).toMatchObject({
      remediatedIssueCount: 1,
      queuedRunCount: 1,
      resolvedRecoveryActionCount: 1,
    });
    expect(second).toMatchObject({ remediatedIssueCount: 0, queuedRunCount: 0 });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue).toMatchObject({
      executionWorkspaceId: null,
      projectWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "reuse_existing" },
    });
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recoveryActionId));
    expect(resolved).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(first.after.incidentCounts.fallback_agent_home_cwd).toBe(0);
    expect(first.after.incidentCounts.non_reusable_reuse_existing_binding).toBe(0);
    expect(first.after.incidentCounts.stale_execution_workspace_binding).toBe(0);
  });
});

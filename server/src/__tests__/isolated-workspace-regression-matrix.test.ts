import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companySkills,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
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
  buildExecutionWorkspaceAdapterConfig,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../services/execution-workspace-policy.js";
import {
  evaluateExecutionWorkspaceReuseCompatibility,
  heartbeatService,
  provisionExecutionWorkspaceForFreshnessDecision,
  resolveExecutionWorkspaceConfigFreshness,
} from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const now = new Date("2026-09-08T12:00:00.000Z");
const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  summary: "Synthetic isolated-workspace matrix run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: adapterExecute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createSyntheticRepository() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-isolated-matrix-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "synthetic repository\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function realizeSyntheticWorktree(input: {
  repoRoot: string;
  issueId: string;
  identifier: string;
  title: string;
  config?: Record<string, unknown>;
}) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: input.repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "project-workspace-1",
      repoUrl: null,
      repoRef: "HEAD",
    },
    config: input.config ?? {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    },
    issue: { id: input.issueId, identifier: input.identifier, title: input.title },
    agent: { id: "agent-1", name: "Synthetic agent", companyId: "company-1" },
  });
}

function compatibilityWorkspace(
  realized: Awaited<ReturnType<typeof realizeSyntheticWorktree>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace" as const,
    strategyType: "git_worktree" as const,
    name: "Synthetic workspace",
    status: "active" as const,
    deliveryState: "unmerged" as const,
    cwd: realized.cwd,
    repoUrl: null,
    baseRef: "HEAD",
    branchName: realized.branchName,
    providerType: "git_worktree" as const,
    providerRef: realized.worktreePath,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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
    providerType: "git_worktree",
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
    deliveryState: "unknown" as const,
  } as typeof executionWorkspaces.$inferSelect & { deliveryState: "unknown" };
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
    reuseCompatibility: { reusable: true, reason: null },
    ...overrides,
  };
}

describe("isolated workspace nine-scenario regression matrix", () => {
  it("1. accepts a project-default isolated git worktree realization", async () => {
    const repoRoot = await createSyntheticRepository();
    try {
      const realized = await realizeSyntheticWorktree({
        repoRoot,
        issueId: "issue-1",
        identifier: "SYN-1",
        title: "Project default realization",
      });
      expect(realized.strategy).toBe("git_worktree");
      expect(realized.worktreePath).toBeTruthy();
      await expect(execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: realized.cwd }))
        .resolves.toMatchObject({ stdout: expect.stringContaining("true") });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
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

  it("3. accepts an issue-level isolated override over a shared project default", async () => {
    const repoRoot = await createSyntheticRepository();
    try {
      const projectPolicy = parseProjectExecutionWorkspacePolicy({
        enabled: true,
        defaultMode: "shared_workspace",
        defaultProjectWorkspaceId: "project-workspace-1",
        workspaceStrategy: { type: "project_primary" },
      });
      const issueSettings = parseIssueExecutionWorkspaceSettings({
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree" },
      });
      const mode = resolveExecutionWorkspaceMode({
        projectPolicy,
        issueSettings,
        legacyUseProjectWorkspace: null,
      });
      const config = buildExecutionWorkspaceAdapterConfig({
        agentConfig: {},
        projectPolicy,
        issueSettings,
        mode,
        legacyUseProjectWorkspace: null,
      });
      const realized = await realizeSyntheticWorktree({
        repoRoot,
        issueId: "issue-3",
        identifier: "SYN-3",
        title: "Issue override realization",
        config,
      });
      expect(mode).toBe("isolated_workspace");
      expect(realized.strategy).toBe("git_worktree");
      expect(realized.worktreePath).not.toBe(repoRoot);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("4. accepts active compatible reuse", async () => {
    const repoRoot = await createSyntheticRepository();
    try {
      const first = await realizeSyntheticWorktree({
        repoRoot,
        issueId: "issue-4",
        identifier: "SYN-4",
        title: "Compatible reuse",
      });
      const restored = await realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "project-workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}-{{slug}}" } },
        issue: { id: "issue-4", identifier: "SYN-4", title: "Compatible reuse" },
        agent: { id: "agent-1", name: "Synthetic agent", companyId: "company-1" },
        recordedBranchOwnership: { branchName: first.branchName!, createdByRuntime: true },
      });
      const compatibility = await evaluateExecutionWorkspaceReuseCompatibility({
        workspace: compatibilityWorkspace(restored),
        expectedCompanyId: "company-1",
        expectedProjectId: "project-1",
        expectedProjectWorkspaceId: "project-workspace-1",
        requestedExecutionWorkspaceMode: "isolated_workspace",
        requestedBranchName: restored.branchName,
        expectedRepoRoot: repoRoot,
        inspectFilesystem: true,
      });
      expect(restored.created).toBe(false);
      expect(compatibility).toEqual({ reusable: true, reason: null });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("5. replaces merged, archived, or missing reuse through production provisioning", async () => {
    const repoRoot = await createSyntheticRepository();
    try {
      const realized = await realizeSyntheticWorktree({
        repoRoot,
        issueId: "issue-5",
        identifier: "SYN-5",
        title: "Non reusable binding",
      });
      const active = compatibilityWorkspace(realized);
      const common = {
        expectedCompanyId: "company-1",
        expectedProjectId: "project-1",
        expectedProjectWorkspaceId: "project-workspace-1",
        requestedExecutionWorkspaceMode: "isolated_workspace" as const,
        expectedRepoRoot: repoRoot,
        inspectFilesystem: true,
      };
      const cases = [
        {
          name: "merged",
          workspace: { ...active, deliveryState: "merged_by_ancestry" as const },
          expectedReason: "workspace_merged:merged_by_ancestry",
        },
        {
          name: "archived",
          workspace: { ...active, status: "archived" as const, closedAt: now },
          expectedReason: "workspace_archived",
        },
        {
          name: "missing",
          workspace: {
            ...active,
            cwd: path.join(repoRoot, "missing"),
            providerRef: path.join(repoRoot, "missing"),
          },
          expectedReason: "workspace_worktree_unavailable",
        },
      ];
      const replacementPaths: string[] = [];
      for (const [index, testCase] of cases.entries()) {
        const compatibility = await evaluateExecutionWorkspaceReuseCompatibility({
          ...common,
          workspace: testCase.workspace,
        });
        expect(compatibility).toMatchObject({
          reusable: false,
          reason: expect.stringContaining(testCase.expectedReason),
        });
        const freshness = resolveExecutionWorkspaceConfigFreshness({
          hasExistingWorkspace: compatibility.reusable,
          existingWorkspaceMetadata: null,
          nextMetadata: null,
        });
        const replacement = await provisionExecutionWorkspaceForFreshnessDecision({
          requestedShouldReuseExisting: true,
          existingExecutionWorkspaceId: active.id,
          issueRef: { id: `issue-5-${testCase.name}`, identifier: `SYN-${50 + index}` },
          runId: `run-5-${testCase.name}`,
          workspaceConfigFreshness: freshness,
          restoreExistingWorkspace: null,
          realizeWorkspace: async () => {
            throw new Error("Non-reusable workspaces must not use the ordinary realization path");
          },
          allowFreshWorkspaceOnNonReusable: true,
          workspaceNotReusableReason: compatibility.reason,
          realizeFreshWorkspace: () => realizeSyntheticWorktree({
            repoRoot,
            issueId: `issue-5-${testCase.name}`,
            identifier: `SYN-${50 + index}`,
            title: `Fresh ${testCase.name} replacement`,
          }),
        });
        expect(replacement.reusedExecutionWorkspace).toBeNull();
        expect(replacement.policy.shouldRestoreExistingWorkspace).toBe(false);
        expect(replacement.executionWorkspace.created).toBe(true);
        expect(replacement.executionWorkspace.worktreePath).not.toBe(realized.worktreePath);
        replacementPaths.push(replacement.executionWorkspace.worktreePath!);
      }
      expect(new Set(replacementPaths).size).toBe(cases.length);
      const wrongRepoRoot = await createSyntheticRepository();
      try {
        await expect(evaluateExecutionWorkspaceReuseCompatibility({
          ...common,
          workspace: active,
          expectedRepoRoot: wrongRepoRoot,
        })).resolves.toMatchObject({
          reusable: false,
          reason: expect.stringContaining("workspace_worktree_unavailable"),
        });
      } finally {
        await rm(wrongRepoRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("7. accepts distinct compatible worktrees for sibling issues", async () => {
    const repoRoot = await createSyntheticRepository();
    try {
      const [siblingA, siblingB] = await Promise.all([
        realizeSyntheticWorktree({ repoRoot, issueId: "sibling-a", identifier: "SYN-7", title: "Sibling A" }),
        realizeSyntheticWorktree({ repoRoot, issueId: "sibling-b", identifier: "SYN-8", title: "Sibling B" }),
      ]);
      expect(siblingA.worktreePath).not.toBe(siblingB.worktreePath);
      expect(siblingA.branchName).not.toBe(siblingB.branchName);
      const worktreeList = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
      expect(worktreeList.stdout).toContain(siblingA.worktreePath!);
      expect(worktreeList.stdout).toContain(siblingB.worktreePath!);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("9. emits sanitized evidence with no paths, repository URLs, names, or private content", async () => {
    const finding = await classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({
        identifier: "../../private/issue",
        status: "/private/status",
        executionWorkspacePreference: "https://private.example/preference",
      }),
      executionWorkspace: executionWorkspaceRow({
        name: "private-workspace-name",
        mode: "/private/mode",
        strategyType: "ssh://private.example/strategy",
        providerType: "private-provider diagnostics",
        status: "raw run output",
        branchName: "private-branch-name",
        closedAt: now,
      }),
      latestRun: {
        id: "run-1",
        issueId: "issue-1",
        workspaceValidationReason: "/private/raw-diagnostic",
        createdAt: now,
      },
      reuseCompatibility: undefined,
    }));
    const encoded = JSON.stringify(finding);
    expect(encoded).not.toContain("/private/");
    expect(encoded).not.toContain("private.example");
    expect(encoded).not.toContain("must-not-leak");
    expect(encoded).not.toContain("Synthetic issue");
    expect(encoded).not.toContain("private-workspace-name");
    expect(encoded).not.toContain("private-branch-name");
    expect(encoded).not.toContain("raw run output");
    expect(encoded).not.toContain("private-provider");
    expect(encoded).not.toContain("raw-diagnostic");
    expect(finding?.issueIdentifier).toBeNull();
    expect(finding?.evidence).toMatchObject({
      issueStatus: "invalid",
      requestedMode: "invalid",
      executionWorkspace: {
        mode: "invalid",
        strategyType: "invalid",
        providerType: "invalid",
        status: "invalid",
      },
    });
  });
});

describe("fleet audit incident coverage", () => {
  it("expires interrupted remediation reservations without reopening a live clear-to-queue gap", async () => {
    const pendingWake = {
      id: "wake-1",
      issueId: "issue-1",
      status: "remediation_pending",
      idempotencyKey: "execution-workspace-remediation:synthetic",
      createdAt: now,
    };
    const pending = snapshot({
      issue: issueRow({ executionWorkspaceId: null }),
      executionWorkspace: null,
      remediationWake: pendingWake,
      evaluatedAt: new Date(now.getTime() + 60_000),
    });
    await expect(classifyExecutionWorkspaceRemediation(pending)).resolves.toBeNull();
    await expect(classifyExecutionWorkspaceRemediation({
      ...pending,
      evaluatedAt: new Date(now.getTime() + 10 * 60_000),
    })).resolves.toMatchObject({
      incidentClasses: expect.arrayContaining(["unrealized_isolated_workspace_request"]),
    });
  });

  it("uses runtime compatibility for merged, incompatible, branch-mismatched, and valid operator workspaces", async () => {
    const merged = await classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
      executionWorkspace: {
        ...executionWorkspaceRow(),
        deliveryState: "merged_by_ancestry",
      },
      reuseCompatibility: undefined,
    }));
    expect(merged?.incidentClasses).toEqual(expect.arrayContaining([
      "stale_execution_workspace_binding",
      "non_reusable_reuse_existing_binding",
    ]));

    for (const executionWorkspace of [
      executionWorkspaceRow({ mode: "shared_workspace" }),
      executionWorkspaceRow({ strategyType: "project_primary" }),
      executionWorkspaceRow({ providerType: "local_fs" }),
    ]) {
      const incompatible = await classifyExecutionWorkspaceRemediation(snapshot({
        issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
        executionWorkspace,
        reuseCompatibility: undefined,
      }));
      expect(incompatible?.incidentClasses).toContain("non_reusable_reuse_existing_binding");
    }

    const branchMismatch = await classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree", existingBranch: "expected-branch" },
        },
      }),
      executionWorkspace: executionWorkspaceRow({ branchName: "other-branch" }),
      reuseCompatibility: undefined,
    }));
    expect(branchMismatch?.incidentClasses).toContain("non_reusable_reuse_existing_binding");

    const repoRoot = await createSyntheticRepository();
    const wrongRepoRoot = await createSyntheticRepository();
    try {
      const realized = await realizeSyntheticWorktree({
        repoRoot,
        issueId: "repo-mismatch",
        identifier: "SYN-90",
        title: "Repository mismatch",
      });
      const repoMismatch = await classifyExecutionWorkspaceRemediation(snapshot({
        issue: issueRow({ executionWorkspacePreference: "reuse_existing" }),
        projectWorkspace: projectWorkspaceRow({ cwd: wrongRepoRoot }),
        primaryProjectWorkspace: projectWorkspaceRow({ cwd: wrongRepoRoot }),
        executionWorkspace: compatibilityWorkspace(realized),
        pathExists: () => true,
        reuseCompatibility: undefined,
      }));
      expect(repoMismatch?.incidentClasses).toContain("non_reusable_reuse_existing_binding");
    } finally {
      await Promise.all([
        rm(repoRoot, { recursive: true, force: true }),
        rm(wrongRepoRoot, { recursive: true, force: true }),
      ]);
    }

    const operatorWorkspace = executionWorkspaceRow({
      mode: "operator_branch",
      strategyType: "project_primary",
      providerType: "local_fs",
      branchName: "operator-branch",
    });
    const validOperator = await classifyExecutionWorkspaceRemediation(snapshot({
      issue: issueRow({ executionWorkspaceSettings: { mode: "operator_branch" } }),
      project: projectRow({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "operator_branch",
          defaultProjectWorkspaceId: "project-workspace-1",
          workspaceStrategy: { type: "project_primary" },
        },
      }),
      executionWorkspace: operatorWorkspace,
    }));
    expect(validOperator).toBeNull();
  });

  it("classifies every supported incident class using sanitized synthetic metadata", async () => {
    const mismatchedProjectWorkspace = projectWorkspaceRow({ projectId: "other-project" });
    const activeFallbackRecovery = {
      id: "recovery-1",
      sourceIssueId: "issue-1",
      status: "active",
      cause: "fallback_agent_home_cwd",
      fingerprint: "fallback_agent_home_cwd:synthetic",
      evidenceReason: "fallback_agent_home_cwd",
    } as ExecutionWorkspaceRemediationSnapshot["activeRecoveryActions"][number];
    const finding = await classifyExecutionWorkspaceRemediation(snapshot({
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
    const missing = await classifyExecutionWorkspaceRemediation(snapshot({
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

describeEmbeddedPostgres("database-backed isolated-workspace matrix", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const tempRepoRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-remediation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await Promise.all(tempRepoRoots.splice(0).map((repoRoot) => rm(repoRoot, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fails closed for malformed and valid-looking nonexistent apply references", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic reference company",
      issuePrefix: `RF${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Private other company",
      issuePrefix: `OT${otherCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: otherCompanyId,
      title: "Private cross-company issue name",
      status: "todo",
      priority: "medium",
      issueNumber: 999,
      identifier: "SYN-999",
    });

    const queueWakeup = vi.fn(async () => ({ id: "must-not-run" }));
    const report = await remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["../../private-issue-name", "SYN-998", "SYN-999"],
      now,
      queueWakeup,
    });

    expect(report).toMatchObject({
      requestedIssueCount: 2,
      remediatedIssueCount: 0,
      queuedRunCount: 0,
      skipped: [
        { issueId: null, issueIdentifier: null, reason: "invalid_issue_reference" },
        { issueId: null, issueIdentifier: null, reason: "invalid_issue_reference" },
        { issueId: null, issueIdentifier: null, reason: "invalid_issue_reference" },
      ],
    });
    expect(queueWakeup).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("private-issue-name");
    expect(JSON.stringify(report)).not.toContain("SYN-998");
    expect(JSON.stringify(report)).not.toContain("SYN-999");
    expect(JSON.stringify(report)).not.toContain("Private cross-company issue name");
  });

  it("6. project, parent, and child creation preserve the resolved project workspace identity", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic inheritance company",
      issuePrefix: `IN${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Synthetic inheritance project",
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
      isPrimary: true,
    });

    const svc = issueService(db);
    const parent = await svc.create(companyId, {
      projectId,
      title: "Parent",
      status: "todo",
      priority: "medium",
    });
    const { issue: child } = await svc.createChild(parent.id, {
      title: "Child",
      status: "todo",
      priority: "medium",
    });
    const { issue: grandchild } = await svc.createChild(child.id, {
      title: "Grandchild",
      status: "todo",
      priority: "medium",
    });

    expect(parent.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.projectId).toBe(projectId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(grandchild.projectId).toBe(projectId);
    expect(grandchild.projectWorkspaceId).toBe(projectWorkspaceId);
  });

  it("8. clears only the invalid binding, resolves recovery, and queues one fresh run across repeated apply", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const recoveryActionId = randomUUID();
    const repoRoot = await createSyntheticRepository();
    tempRepoRoots.push(repoRoot);
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic remediation company",
      issuePrefix: `WR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
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
      cwd: repoRoot,
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
      cwd: path.join(repoRoot, "missing-stale-worktree"),
      branchName: "SYN-1",
      providerType: "git_worktree",
      providerRef: path.join(repoRoot, "missing-stale-worktree"),
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

    const dryRun = await auditExecutionWorkspaceFleet(db, { companyId, now });
    expect(dryRun.incidentCounts.non_reusable_reuse_existing_binding).toBe(1);
    expect(JSON.stringify(dryRun)).not.toContain("/synthetic/");
    expect(JSON.stringify(dryRun)).not.toContain("/must/not/leak");

    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const normalQueue: Parameters<typeof remediateExecutionWorkspaceFleet>[1]["queueWakeup"] = async (input) => {
      const safeContext = {
        issueId: input.issueId,
        taskId: input.issueId,
        taskKey: input.issueIdentifier ?? input.issueId,
        projectId: input.projectId,
        wakeReason: "execution_workspace_fleet_remediation",
        workspaceRemediation: {
          version: 1,
          fingerprint: input.fingerprint,
          incidentClasses: input.incidentClasses,
        },
      };
      return heartbeat.wakeup(input.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "execution_workspace_fleet_remediation",
        payload: safeContext,
        contextSnapshot: safeContext,
        requestedByActorType: "system",
        requestedByActorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      });
    };

    let signalRemediationAtQueue!: () => void;
    const remediationAtQueue = new Promise<void>((resolve) => { signalRemediationAtQueue = resolve; });
    let releaseRemediationQueue!: () => void;
    const remediationQueueGate = new Promise<void>((resolve) => { releaseRemediationQueue = resolve; });
    const queueWakeup: typeof normalQueue = async (input) => {
      signalRemediationAtQueue();
      await remediationQueueGate;
      return normalQueue(input);
    };
    let releaseAdapter!: () => void;
    const adapterGate = new Promise<void>((resolve) => { releaseAdapter = resolve; });
    adapterExecute.mockImplementationOnce(async () => {
      await adapterGate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "Synthetic queue-race run.",
        provider: "test",
        model: "test-model",
      };
    });

    const firstPromise = remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["SYN-1"],
      now,
      queueWakeup,
    });
    await remediationAtQueue;
    const duringClearToQueueGap = await auditExecutionWorkspaceFleet(db, { companyId, now });
    expect(duringClearToQueueGap.findingCount).toBe(0);
    const [clearedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(clearedIssue).toMatchObject({
      executionWorkspaceId: null,
      projectWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "reuse_existing" },
    });
    const ordinaryRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "ordinary_concurrent_wake",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, taskKey: "SYN-1", projectId },
      requestedByActorType: "system",
      requestedByActorId: "test",
      idempotencyKey: `ordinary-concurrent-wake:${issueId}`,
    });
    expect(ordinaryRun).not.toBeNull();
    releaseRemediationQueue();
    const first = await firstPromise;

    // Repeat while the ordinary wake owns the issue execution lock. The
    // remediation wake has coalesced onto that run, so no second run may be
    // queued even if workspace realization has already changed the binding.
    const second = await remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["SYN-1"],
      now,
      queueWakeup: normalQueue,
    });
    releaseAdapter();
    await heartbeat.drainActiveRunExecutions();

    expect(first).toMatchObject({
      remediatedIssueCount: 1,
      queuedRunCount: 1,
      resolvedRecoveryActionCount: 1,
    });
    expect(second).toMatchObject({ remediatedIssueCount: 0, queuedRunCount: 0 });
    const runsAfterRepeatedApply = (await db.select().from(heartbeatRuns)).filter((run) =>
      (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason !== "finish_successful_run_handoff");
    expect(runsAfterRepeatedApply.map((run) => ({
      status: run.status,
      errorCode: run.errorCode,
      wakeReason: (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason ?? null,
    }))).toEqual([{ status: "succeeded", errorCode: null, wakeReason: "ordinary_concurrent_wake" }]);
    const initialExecutionWakes = (await db.select().from(agentWakeupRequests)).filter((wake) =>
      wake.idempotencyKey === `ordinary-concurrent-wake:${issueId}`
      || wake.idempotencyKey?.startsWith("execution-workspace-remediation:") === true);
    expect(initialExecutionWakes).toHaveLength(2);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue).toMatchObject({
      projectWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    expect(updatedIssue!.executionWorkspaceId).not.toBe(executionWorkspaceId);
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recoveryActionId));
    expect(resolved).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(first.after.incidentCounts.fallback_agent_home_cwd).toBe(0);
    expect(first.after.incidentCounts.non_reusable_reuse_existing_binding).toBe(0);
    expect(first.after.incidentCounts.stale_execution_workspace_binding).toBe(0);

    const laterWorkspaceId = randomUUID();
    const laterRecoveryActionId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: laterWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Later archived worktree",
      status: "archived",
      cwd: path.join(repoRoot, "later-missing-worktree"),
      branchName: "SYN-1-later",
      providerType: "git_worktree",
      providerRef: path.join(repoRoot, "later-missing-worktree"),
      closedAt: new Date(now.getTime() + 1_000),
      metadata: { lifecycleGeneration: 2 },
    });
    await db.update(issues).set({ executionWorkspaceId: laterWorkspaceId }).where(eq(issues.id, issueId));
    await db.insert(issueRecoveryActions).values({
      id: laterRecoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "workspace_not_reusable",
      fingerprint: "workspace_not_reusable:later-generation",
      evidence: { workspaceValidation: { reason: "workspace_not_reusable" } },
      nextAction: "Create another fresh isolated workspace.",
    });
    const later = await remediateExecutionWorkspaceFleet(db, {
      companyId,
      issueRefs: ["SYN-1"],
      now: new Date(now.getTime() + 2_000),
      queueWakeup: normalQueue,
    });
    await heartbeat.drainActiveRunExecutions();
    expect(later).toMatchObject({ remediatedIssueCount: 1, queuedRunCount: 1 });
    const nonHandoffRuns = (await db.select().from(heartbeatRuns)).filter((run) =>
      (run.contextSnapshot as Record<string, unknown> | null)?.wakeReason !== "finish_successful_run_handoff");
    expect(nonHandoffRuns).toHaveLength(2);
    const remediationKeys = (await db.select().from(agentWakeupRequests))
      .map((wake) => wake.idempotencyKey)
      .filter((key): key is string => key?.startsWith("execution-workspace-remediation:") === true);
    expect(remediationKeys).toHaveLength(2);
    expect(new Set(remediationKeys).size).toBe(2);
  });
});

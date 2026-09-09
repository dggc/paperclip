import { describe, expect, it } from "vitest";
import {
  buildWorkspaceReadyComment,
  buildWorkspaceReadyMetadata,
  buildWorkspaceReadyPresentation,
  type RealizedExecutionWorkspace,
  type RuntimeServiceRef,
} from "./workspace-runtime.js";

function workspace(
  overrides: Partial<RealizedExecutionWorkspace> = {},
): RealizedExecutionWorkspace {
  return {
    baseCwd: "/repo",
    source: "project_primary",
    projectId: "project-id",
    workspaceId: "project-workspace-id",
    repoUrl: null,
    repoRef: "main",
    strategy: "git_worktree",
    cwd: "/repo/.paperclip/worktrees/PAP-16051",
    branchName: "PAP-16051-workspace-ready-notice",
    worktreePath: "/repo/.paperclip/worktrees/PAP-16051",
    warnings: [],
    created: true,
    branchCreatedByRuntime: true,
    ...overrides,
  };
}

function runtimeService(
  overrides: Partial<RuntimeServiceRef> = {},
): RuntimeServiceRef {
  return {
    id: "service-id",
    companyId: "company-id",
    projectId: "project-id",
    projectWorkspaceId: "project-workspace-id",
    executionWorkspaceId: "execution-workspace-id",
    issueId: "issue-id",
    serviceName: "web",
    status: "running",
    lifecycle: "ephemeral",
    scopeType: "run",
    scopeId: "run-id",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/repo/.paperclip/worktrees/PAP-16051",
    port: 3100,
    url: "http://localhost:3100",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: "agent-id",
    startedByRunId: "run-id",
    lastUsedAt: "2026-08-01T00:00:00.000Z",
    startedAt: "2026-08-01T00:00:00.000Z",
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    exposure: null,
    reused: false,
    ...overrides,
  };
}

describe("workspace-ready comment builders", () => {
  it("uses a compact info notice that is collapsed when the workspace has no warnings", () => {
    const input = { workspace: workspace(), runtimeServices: [] };

    expect(buildWorkspaceReadyPresentation(input)).toEqual({
      kind: "system_notice",
      tone: "info",
      title: "Workspace ready",
      density: "compact",
      detailsDefaultOpen: false,
    });
  });

  it("uses a warning notice that is expanded when warnings are present", () => {
    const input = {
      workspace: workspace({ warnings: ["The worktree was restored from a stale reference."] }),
      runtimeServices: [],
    };

    expect(buildWorkspaceReadyPresentation(input)).toMatchObject({
      tone: "warning",
      detailsDefaultOpen: true,
    });
    expect(buildWorkspaceReadyMetadata(input).sections[0]?.rows).toContainEqual({
      type: "key_value",
      label: "Warning count",
      value: "1",
    });
  });

  it("does not vary the presentation title with workspace identity", () => {
    const presentation = buildWorkspaceReadyPresentation({
      workspace: workspace({ branchName: null, strategy: "project_primary" }),
      runtimeServices: [],
    });

    expect(presentation.title).toBe("Workspace ready");
  });

  it("builds structured workspace and service sections without an empty warnings section", () => {
    const input = {
      workspace: workspace(),
      runtimeServices: [
        runtimeService(),
        runtimeService({
          id: "worker-service-id",
          serviceName: "worker",
          url: null,
          reused: true,
        }),
      ],
    };

    expect(buildWorkspaceReadyMetadata(input)).toEqual({
      version: 1,
      sections: [
        {
          title: "Workspace",
          rows: [
            { type: "key_value", label: "Mode", value: "isolated_workspace" },
            { type: "key_value", label: "Strategy", value: "git_worktree" },
            { type: "key_value", label: "Worktree present", value: "yes" },
            { type: "key_value", label: "Branch present", value: "yes" },
          ],
        },
        {
          title: "Services",
          rows: [
            { type: "key_value", label: "web", value: "http://localhost:3100" },
            { type: "key_value", label: "worker", value: "running (reused)" },
          ],
        },
      ],
    });
  });

  it("keeps service labels within the comment metadata boundary", () => {
    const metadata = buildWorkspaceReadyMetadata({
      workspace: workspace(),
      runtimeServices: [runtimeService({ serviceName: `  ${"s".repeat(150)}  ` })],
    });
    const serviceLabel = metadata.sections[1]?.rows[0];

    expect(serviceLabel).toEqual({
      type: "key_value",
      label: `${"s".repeat(119)}…`,
      value: "http://localhost:3100",
    });
  });

  it("redacts workspace identity and diagnostics while preserving presence evidence", () => {
    const sensitiveRepoUrl = "ssh://git.example.test/private/project.git";
    const sensitiveBranch = "private/customer-branch";
    const sensitiveCwd = "/private/repos/customer/runtime";
    const sensitiveWorktree = "/private/repos/customer/worktrees/change";
    const sensitiveDiagnostic = `Failed at ${sensitiveWorktree} on ${sensitiveBranch}`;
    const input = {
      workspace: workspace({
        repoUrl: sensitiveRepoUrl,
        repoRef: "private/default-ref",
        branchName: sensitiveBranch,
        cwd: sensitiveCwd,
        worktreePath: sensitiveWorktree,
        warnings: [sensitiveDiagnostic],
      }),
      runtimeServices: [runtimeService({ reused: true })],
    };

    expect(buildWorkspaceReadyMetadata(input).sections[0]).toEqual({
      title: "Workspace",
      rows: [
        { type: "key_value", label: "Mode", value: "isolated_workspace" },
        { type: "key_value", label: "Strategy", value: "git_worktree" },
        { type: "key_value", label: "Worktree present", value: "yes" },
        { type: "key_value", label: "Branch present", value: "yes" },
        { type: "key_value", label: "Warning count", value: "1" },
      ],
    });
    const body = buildWorkspaceReadyComment(input);
    expect(body).toBe([
      "## Workspace Ready",
      "",
      "- Mode: `isolated_workspace`",
      "- Strategy: `git_worktree`",
      "- Worktree present: `yes`",
      "- Branch present: `yes`",
      "- Warning count: `1` (inspect the linked run for details)",
      "- Service: web: http://localhost:3100 (reused)",
    ].join("\n"));

    const issueFacingPayload = JSON.stringify({
      body,
      presentation: buildWorkspaceReadyPresentation(input),
      metadata: buildWorkspaceReadyMetadata(input),
    });
    for (const sensitiveValue of [
      sensitiveRepoUrl,
      "private/default-ref",
      sensitiveBranch,
      sensitiveCwd,
      sensitiveWorktree,
      sensitiveDiagnostic,
    ]) {
      expect(issueFacingPayload).not.toContain(sensitiveValue);
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import type { RealizedExecutionWorkspace, RuntimeServiceRef } from "../services/workspace-runtime.js";
import { postWorkspaceReadyComment } from "../services/heartbeat.js";

describe("heartbeat workspace-ready comment", () => {
  it("passes presentation and metadata in the addComment options argument", async () => {
    const workspace: RealizedExecutionWorkspace = {
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
    };
    const runtimeServices: RuntimeServiceRef[] = [];
    const addComment = vi.fn().mockResolvedValue({ id: "comment-id" });

    await postWorkspaceReadyComment({
      issuesSvc: { addComment },
      issueId: "issue-id",
      agentId: "agent-id",
      runId: "run-id",
      workspace,
      runtimeServices,
    });

    expect(addComment).toHaveBeenCalledOnce();
    expect(addComment).toHaveBeenCalledWith(
      "issue-id",
      [
        "## Workspace Ready",
        "",
        "- Mode: `isolated_workspace`",
        "- Strategy: `git_worktree`",
        "- Worktree present: `yes`",
        "- Branch present: `yes`",
      ].join("\n"),
      { agentId: "agent-id", runId: "run-id" },
      {
        presentation: {
          kind: "system_notice",
          tone: "info",
          title: "Workspace ready",
          density: "compact",
          detailsDefaultOpen: false,
        },
        metadata: {
          version: 1,
          sections: [{
            title: "Workspace",
            rows: [
              { type: "key_value", label: "Mode", value: "isolated_workspace" },
              { type: "key_value", label: "Strategy", value: "git_worktree" },
              { type: "key_value", label: "Worktree present", value: "yes" },
              { type: "key_value", label: "Branch present", value: "yes" },
            ],
          }],
        },
      },
    );
  });
});

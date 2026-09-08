import { companies, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  auditExecutionWorkspaceFleet,
  remediateExecutionWorkspaceFleet,
  type QueueExecutionWorkspaceRemediationWake,
} from "../server/src/services/execution-workspace-remediation.js";
import { heartbeatService } from "../server/src/services/heartbeat.js";

function flagValues(name: string) {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  const apply = hasFlag("--apply");
  const summaryOnly = hasFlag("--summary");
  const companyIds = flagValues("--company");
  const issueRefs = flagValues("--issue");
  const heartbeat = heartbeatService(db);
  const queueWakeup: QueueExecutionWorkspaceRemediationWake = async (input) => {
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

  if (apply && companyIds.length !== 1) {
    throw new Error("--apply requires exactly one --company <id> to keep mutation scope explicit.");
  }
  if (apply && issueRefs.length === 0) {
    throw new Error("--apply requires at least one --issue <id-or-identifier>; bulk implicit mutation is not allowed.");
  }

  const targets = companyIds.length > 0
    ? [...new Set(companyIds)]
    : await db.select({ id: companies.id }).from(companies).then((rows) => rows.map((row) => row.id));
  const reports = [];
  for (const companyId of targets) {
    reports.push(apply
      ? await remediateExecutionWorkspaceFleet(db, {
          companyId,
          issueRefs,
          actorId: "execution_workspace_remediation_cli",
          queueWakeup,
        })
      : await auditExecutionWorkspaceFleet(db, { companyId }));
  }
  console.log(JSON.stringify({
    version: 1,
    mode: apply ? "apply" : "dry_run",
    companyCount: reports.length,
    reports: summaryOnly
      ? reports.map((report) => report.dryRun
          ? {
              companyId: report.companyId,
              checkedIssueCount: report.checkedIssueCount,
              findingCount: report.findingCount,
              incidentCounts: report.incidentCounts,
            }
          : {
              companyId: report.companyId,
              requestedIssueCount: report.requestedIssueCount,
              remediatedIssueCount: report.remediatedIssueCount,
              queuedRunCount: report.queuedRunCount,
              resolvedRecoveryActionCount: report.resolvedRecoveryActionCount,
              skippedCount: report.skipped.length,
              beforeFindingCount: report.before.findingCount,
              afterFindingCount: report.after.findingCount,
            })
      : reports,
  }, null, 2));
}

void main().catch(() => {
  console.error("Execution-workspace remediation failed: execution_workspace_remediation_failed");
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// OpenProject task-cache sync, called from the sweep.
//
// Tasks are OpenProject work packages, cached locally so the tool chain never
// depends on OpenProject being up (docs/tasks.md). The connector is read-only
// and never retries; this module owns graceful degradation instead: a dead
// OpenProject costs one warning line per project and the cache keeps whatever
// it had. Missing configuration is not a failure — no url/apiKey means no
// OpenProject is configured, which is the normal state on a machine without
// .env secrets, and the sweep stays silent about it. The projects mapping is
// the only file-backed part, so its absence gets one precise warning: without
// it there is no way to know which OpenProject project an hours project maps
// to, and syncing nothing is better than guessing.
// ---------------------------------------------------------------------------

import { loadConfig } from '@hours/config';
import { upsertTasks, type TaskInput } from '@hours/lib-db';
import { listWorkPackages, OpenProjectError } from '@hours/connector-openproject';

export interface SyncTasksResult {
  /** Number of work packages upserted this sweep (0 when nothing to write). */
  synced: number;
  /** Work packages fetched per hours project key. */
  byProject: Record<string, number>;
  /** Non-fatal problems; every network or config failure lands here, never a throw. */
  warnings: string[];
}

export async function syncTasks(): Promise<SyncTasksResult> {
  const cfg = loadConfig();
  const { url, apiKey, projects } = cfg.openproject;

  // No OpenProject configured is a normal state, not an error — stay silent so
  // the sweep's warnings only ever mean something.
  if (!url || !apiKey) {
    return { synced: 0, byProject: {}, warnings: [] };
  }

  if (!projects) {
    return {
      synced: 0,
      byProject: {},
      warnings: [
        '"openproject.projects" mapping missing in hours.config.json — add {"north10": "north10-ai"} to cache tasks',
      ],
    };
  }

  const warnings: string[] = [];
  const byProject: Record<string, number> = {};
  const inputs: TaskInput[] = [];

  try {
    for (const [hoursKey, opIdentifier] of Object.entries(projects)) {
      const project = cfg.projects.find((p) => p.key === hoursKey);
      if (!project) {
        warnings.push(
          `openproject: mapped key "${hoursKey}" is not a project in hours.config.json — fix or remove the mapping`,
        );
        continue;
      }
      try {
        const wps = await listWorkPackages({ url, apiKey, projectIdentifier: opIdentifier });
        for (const wp of wps) {
          inputs.push({
            id: wp.id,
            projectKey: hoursKey,
            subject: wp.subject,
            // Null means the API did not return the field — omit it so the
            // upsert keeps the previously cached value instead of wiping it.
            ...(wp.status !== null ? { status: wp.status } : {}),
            ...(wp.spentMinutes !== null ? { spentMinutes: wp.spentMinutes } : {}),
            ...(wp.estimatedMinutes !== null ? { estimatedMinutes: wp.estimatedMinutes } : {}),
          });
        }
        byProject[hoursKey] = wps.length;
      } catch (err) {
        warnings.push(`openproject ${hoursKey} (${opIdentifier}): ${describeFailure(err)}`);
      }
    }

    const stored = await upsertTasks(inputs);
    return { synced: stored.length, byProject, warnings };
  } catch (err) {
    // Last-resort guard: the sweep must survive anything the connector or the
    // cache throws, even a bug in this module.
    warnings.push(`openproject sync: ${err instanceof Error ? err.message : String(err)}`);
    return { synced: 0, byProject, warnings };
  }
}

function describeFailure(err: unknown): string {
  if (err instanceof OpenProjectError) {
    return `OpenProjectError (status ${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

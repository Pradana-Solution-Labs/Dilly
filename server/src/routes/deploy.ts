import { Elysia, t } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { dockerService } from "../services/docker.js";
import { composeService } from "../services/compose.js";
import { caddyService } from "../services/caddy.js";
import { gitService } from "../services/git.js";
import path from "path";
import fs from "fs/promises";
import { config } from "../config.js";

export interface RunDeploymentOptions {
  triggeredBy: "manual" | "webhook" | "api";
  user?: { name: string; role: string };
  commitHash?: string | null;
  commitMessage?: string | null;
}

/**
 * Executes a full deployment pipeline for a service
 */
export async function runDeployment(
  serviceId: string,
  options: RunDeploymentOptions
): Promise<{ deploymentId: string; status: string; message: string }> {
  const [service] = await db.select().from(schema.services).where(eq(schema.services.id, serviceId));
  if (!service) {
    throw new Error("Service not found");
  }

  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, service.projectId));
  if (!project) {
    throw new Error("Project not found");
  }

  const initialAuthor = options.user ? `${options.user.name} (${options.user.role})` : options.triggeredBy;
  const initialLog = `[${new Date().toISOString()}] Deployment initiated via ${options.triggeredBy} by ${initialAuthor}\n`;

  // Create deployment record
  const [deployment] = await db
    .insert(schema.deployments)
    .values({
      serviceId: service.id,
      status: "building",
      triggeredBy: options.triggeredBy,
      commitHash: options.commitHash || null,
      commitMessage: options.commitMessage || null,
      logs: initialLog,
    })
    .returning();

  // Update service status
  await db
    .update(schema.services)
    .set({ status: "deploying", updatedAt: new Date() })
    .where(eq(schema.services.id, service.id));

  // Execute deployment in background
  (async () => {
    let deployLogs = deployment.logs || "";
    const appendLog = (line: string) => {
      deployLogs += line;
    };

    try {
      const workspaceDir = path.resolve(config.dataDir, project.name, service.name);
      let activeCommitHash = options.commitHash || "";
      let activeCommitMessage = options.commitMessage || "";

      // Step 1: Git Synchronization if gitUrl is configured
      if (service.gitUrl && service.gitUrl.trim()) {
        appendLog(`[${new Date().toISOString()}] Synchronizing Git repository: ${service.gitUrl} (branch: ${service.gitBranch || "main"})...\n`);
        const gitRes = await gitService.cloneOrPull({
          serviceId: service.id,
          repoUrl: service.gitUrl,
          branch: service.gitBranch || "main",
          targetDir: workspaceDir,
          privateKey: service.sshPrivateKey,
          onLog: appendLog,
        });

        if (!gitRes.success) {
          throw new Error("Git clone/pull failed to complete.");
        }

        activeCommitHash = gitRes.commitHash || activeCommitHash;
        activeCommitMessage = gitRes.commitMessage || activeCommitMessage;

        // Update deployment record with commit info
        await db
          .update(schema.deployments)
          .set({
            commitHash: activeCommitHash,
            commitMessage: activeCommitMessage,
          })
          .where(eq(schema.deployments.id, deployment.id));
      }

      // Fetch environment variables
      const envRecords = await db.select().from(schema.envVars).where(eq(schema.envVars.serviceId, service.id));
      const envMap: Record<string, string> = {};
      for (const env of envRecords) {
        envMap[env.key] = env.value;
      }

      if (service.type === "compose") {
        appendLog(`[${new Date().toISOString()}] Executing Docker Compose deployment...\n`);
        const composeProjectName = `${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");

        // If in-place composeContent is present, sync it to workspace
        if (service.composeContent) {
          await composeService.writeComposeFile(workspaceDir, service.composeContent, service.composePath || "docker-compose.yml");
          appendLog(`[${new Date().toISOString()}] Synced in-place compose configuration to workspace.\n`);
        }

        const result = await composeService.up(workspaceDir, composeProjectName, envMap, (chunk) => {
          appendLog(chunk);
        });

        if (!result.success) {
          throw new Error(`Compose up failed with exit code ${result.exitCode}`);
        }

        // Sync Caddy route if domain provided
        if (service.domain) {
          appendLog(`[${new Date().toISOString()}] Configuring Caddy proxy for domain ${service.domain}...\n`);
          await caddyService.setRoute(service.domain, `${composeProjectName}_web`, service.internalPort || 80);
        }

        await db
          .update(schema.services)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.services.id, service.id));

        await db
          .update(schema.deployments)
          .set({
            status: "success",
            commitHash: activeCommitHash || undefined,
            commitMessage: activeCommitMessage || undefined,
            logs: deployLogs,
            finishedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));
      } else {
        // Dockerfile service execution
        appendLog(`[${new Date().toISOString()}] Executing Dockerfile service deployment...\n`);
        const containerName = `dilly_${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");

        // Stop and remove old container if exists
        if (service.currentContainerId) {
          try {
            await dockerService.stopContainer(service.currentContainerId);
            await dockerService.removeContainer(service.currentContainerId);
            appendLog(`[${new Date().toISOString()}] Cleaned up previous container ${service.currentContainerId}\n`);
          } catch {}
        }

        let imageToRun = "";
        const hasGit = Boolean(service.gitUrl && service.gitUrl.trim());
        const hasDockerfileContent = Boolean(service.dockerfileContent && service.dockerfileContent.trim());

        if (hasGit || hasDockerfileContent) {
          const imageTag = `dilly_${project.name}_${service.name}:latest`.toLowerCase().replace(/[^a-z0-9_.-]/g, "");
          if (hasDockerfileContent) {
            const dockerfilePath = path.join(workspaceDir, service.dockerfilePath || "Dockerfile");
            await fs.mkdir(workspaceDir, { recursive: true });
            await fs.writeFile(dockerfilePath, service.dockerfileContent!, "utf-8");
            appendLog(`[${new Date().toISOString()}] Wrote in-place Dockerfile to workspace.\n`);
          }

          appendLog(`[${new Date().toISOString()}] Building Docker image ${imageTag} from ${service.dockerfilePath || "Dockerfile"}...\n`);
          const buildRes = await dockerService.buildImage(
            workspaceDir,
            service.dockerfilePath || "Dockerfile",
            imageTag,
            (chunk) => appendLog(chunk)
          );

          if (!buildRes.success) {
            throw new Error(`Docker build failed with exit code ${buildRes.exitCode}`);
          }

          imageToRun = imageTag;
          appendLog(`[${new Date().toISOString()}] Image ${imageTag} built successfully.\n`);
        } else {
          imageToRun = service.gitUrl || "traefik/whoami";
          appendLog(`[${new Date().toISOString()}] Using image: ${imageToRun}...\n`);
        }

        const container = await dockerService.runContainer({
          image: imageToRun,
          name: containerName,
          env: envMap,
          exposedPort: service.internalPort || 80,
          onProgress: (chunk) => appendLog(chunk),
        });

        const containerId = container.id;
        appendLog(`[${new Date().toISOString()}] Container ${containerId.substring(0, 12)} is running.\n`);

        if (service.domain) {
          appendLog(`[${new Date().toISOString()}] Registering domain ${service.domain} with Caddy...\n`);
          await caddyService.setRoute(service.domain, containerName, service.internalPort || 80);
        }

        await db
          .update(schema.services)
          .set({
            status: "running",
            currentContainerId: containerId,
            updatedAt: new Date(),
          })
          .where(eq(schema.services.id, service.id));

        await db
          .update(schema.deployments)
          .set({
            status: "success",
            commitHash: activeCommitHash || undefined,
            commitMessage: activeCommitMessage || undefined,
            logs: deployLogs,
            finishedAt: new Date(),
          })
          .where(eq(schema.deployments.id, deployment.id));
      }
    } catch (err: any) {
      appendLog(`\n[${new Date().toISOString()}] DEPLOYMENT FAILED: ${err.message}\n`);
      await db
        .update(schema.services)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      await db
        .update(schema.deployments)
        .set({ status: "failed", logs: deployLogs, finishedAt: new Date() })
        .where(eq(schema.deployments.id, deployment.id));
    }
  })();

  return {
    deploymentId: deployment.id,
    status: "building",
    message: "Deployment queued and building in background",
  };
}

export const deployRoutes = new Elysia({ prefix: "/api/services" })
  .use(authMiddleware)
  .post(
    "/:id/deploy",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      try {
        const result = await runDeployment(params.id, {
          triggeredBy: "manual",
          user: { name: user.name, role: user.role },
        });
        return result;
      } catch (err: any) {
        set.status = err.message === "Service not found" ? 404 : 500;
        return { error: err.message };
      }
    },
    {
      requireRole: "developer",
    }
  )
  .post(
    "/:id/restart",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      if (!service.currentContainerId) {
        set.status = 400;
        return { error: "No container assigned to this service" };
      }

      await dockerService.restartContainer(service.currentContainerId);
      await db
        .update(schema.services)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      return { success: true, status: "running" };
    },
    {
      requireRole: "developer",
    }
  )
  .post(
    "/:id/stop",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service || !service.currentContainerId) {
        set.status = 400;
        return { error: "No active container for this service" };
      }

      await dockerService.stopContainer(service.currentContainerId);
      await db
        .update(schema.services)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      return { success: true, status: "stopped" };
    },
    {
      requireRole: "developer",
    }
  )
  .get(
    "/:id/deployments",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const history = await db
        .select()
        .from(schema.deployments)
        .where(eq(schema.deployments.serviceId, params.id))
        .orderBy(desc(schema.deployments.startedAt))
        .limit(20);

      return history;
    },
    {
      requireRole: "viewer",
    }
  );

import { Elysia, t } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { dockerService } from "../services/docker.js";
import { composeService } from "../services/compose.js";
import { caddyService } from "../services/caddy.js";
import path from "path";
import { config } from "../config.js";

export const deployRoutes = new Elysia({ prefix: "/api/services" })
  .use(authMiddleware)
  .post(
    "/:id/deploy",
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

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, service.projectId));

      // Create deployment record
      const [deployment] = await db
        .insert(schema.deployments)
        .values({
          serviceId: service.id,
          status: "building",
          logs: `[${new Date().toISOString()}] Deployment initiated by ${user.name} (${user.role})\n`,
        })
        .returning();

      // Update service status
      await db
        .update(schema.services)
        .set({ status: "deploying", updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      // Fetch environment variables
      const envRecords = await db.select().from(schema.envVars).where(eq(schema.envVars.serviceId, service.id));
      const envMap: Record<string, string> = {};
      for (const env of envRecords) {
        envMap[env.key] = env.value;
      }

      // Execute deployment in background
      (async () => {
        let deployLogs = deployment.logs || "";
        const appendLog = (line: string) => {
          deployLogs += line;
        };

        try {
          if (service.type === "compose") {
            appendLog(`[${new Date().toISOString()}] Executing Docker Compose deployment...\n`);
            const composeDir = path.resolve(config.dataDir, project.name, service.name);
            const composeProjectName = `${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");

            if (service.composeContent) {
              await composeService.writeComposeFile(composeDir, service.composeContent, service.composePath || "docker-compose.yml");
              appendLog(`[${new Date().toISOString()}] Synced in-place docker-compose.yml to workspace.\n`);
            }

            const result = await composeService.up(composeDir, composeProjectName, envMap, (chunk) => {
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
              .set({ status: "success", logs: deployLogs, finishedAt: new Date() })
              .where(eq(schema.deployments.id, deployment.id));
          } else {
            // Dockerfile service execution
            appendLog(`[${new Date().toISOString()}] Starting container for ${service.name}...\n`);
            const containerName = `dilly_${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");

            // Stop and remove old container if exists
            if (service.currentContainerId) {
              try {
                await dockerService.stopContainer(service.currentContainerId);
                await dockerService.removeContainer(service.currentContainerId);
                appendLog(`[${new Date().toISOString()}] Cleaned up previous container ${service.currentContainerId}\n`);
              } catch (e) {
                // Ignore if container already stopped or absent
              }
            }

            // In local/production, run or spawn image (placeholder base or pre-built image)
            const targetImage = service.gitUrl || "traefik/whoami";
            appendLog(`[${new Date().toISOString()}] Preparing image: ${targetImage}...\n`);
            const container = await dockerService.runContainer({
              image: targetImage,
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
              .set({ status: "success", logs: deployLogs, finishedAt: new Date() })
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

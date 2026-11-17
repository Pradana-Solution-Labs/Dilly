import { Elysia, t } from "elysia";
import { authMiddleware } from "../middlewares/auth.js";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { dockerService } from "../services/docker.js";
import { caddyService } from "../services/caddy.js";
import { extractComposeEnvVars } from "../services/env-parser.js";
import { gitService } from "../services/git.js";
import { runDeployment } from "./deploy.js";
import crypto from "crypto";

export const serviceRoutes = new Elysia({ prefix: "/api/services" })
  .use(authMiddleware)
  .post(
    "/project/:projectId",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, params.projectId));
      if (!project) {
        set.status = 404;
        return { error: "Project not found" };
      }

      const [created] = await db
        .insert(schema.services)
        .values({
          projectId: project.id,
          name: body.name,
          type: body.type,
          gitUrl: body.gitUrl,
          gitBranch: body.gitBranch || "main",
          dockerfilePath: body.dockerfilePath || "Dockerfile",
          composePath: body.composePath || "docker-compose.yml",
          composeContent: body.composeContent,
          dockerfileContent: body.dockerfileContent,
          domain: body.domain,
          internalPort: body.internalPort || 80,
          webhookSecret: crypto.randomBytes(24).toString("hex"),
          webhookEnabled: true,
        })
        .returning();

      // If composeContent is supplied at creation, auto-extract environment variables!
      if (body.composeContent) {
        const extracted = extractComposeEnvVars(body.composeContent);
        for (const item of extracted) {
          await db.insert(schema.envVars).values({
            serviceId: created.id,
            key: item.key,
            value: item.defaultValue,
            isSecret: item.isSecret,
          });
        }
      }

      return created;
    },
    {
      requireRole: "admin",
      body: t.Object({
        name: t.String({ minLength: 2, maxLength: 50 }),
        type: t.Union([t.Literal("dockerfile"), t.Literal("compose")]),
        gitUrl: t.Optional(t.String()),
        gitBranch: t.Optional(t.String()),
        dockerfilePath: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        composeContent: t.Optional(t.String()),
        dockerfileContent: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        internalPort: t.Optional(t.Number()),
        webhookEnabled: t.Optional(t.Boolean()),
      }),
    }
  )
  .get(
    "/:id",
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

      const envList = await db
        .select({
          id: schema.envVars.id,
          key: schema.envVars.key,
          value: schema.envVars.value,
          isSecret: schema.envVars.isSecret,
        })
        .from(schema.envVars)
        .where(eq(schema.envVars.serviceId, service.id));

      // Obfuscate secret values for viewer role
      const safeEnv = envList.map((env) => ({
        ...env,
        value: env.isSecret && user.role === "viewer" ? "••••••••" : env.value,
      }));

      // Ensure webhookSecret exists for existing legacy services
      let activeWebhookSecret = service.webhookSecret;
      if (!activeWebhookSecret) {
        activeWebhookSecret = crypto.randomBytes(24).toString("hex");
        await db
          .update(schema.services)
          .set({ webhookSecret: activeWebhookSecret })
          .where(eq(schema.services.id, service.id));
      }

      const { sshPrivateKey, ...safeService } = service;

      return {
        ...safeService,
        webhookSecret: activeWebhookSecret,
        hasDeployKey: Boolean(sshPrivateKey),
        envVars: safeEnv,
      };
    },
    {
      requireRole: "viewer",
    }
  )
  .patch(
    "/:id",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      const [updated] = await db
        .update(schema.services)
        .set({
          ...body,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, params.id))
        .returning();

      // If domain changed, update Caddy route
      if (body.domain !== undefined && body.domain !== service.domain) {
        if (service.domain) {
          await caddyService.removeRoute(service.domain);
        }
        if (body.domain && updated.currentContainerId) {
          await caddyService.setRoute(body.domain, updated.name, updated.internalPort || 80);
        }
      }

      return updated;
    },
    {
      requireRole: "admin",
      body: t.Object({
        name: t.Optional(t.String()),
        gitUrl: t.Optional(t.String()),
        gitBranch: t.Optional(t.String()),
        dockerfilePath: t.Optional(t.String()),
        composePath: t.Optional(t.String()),
        composeContent: t.Optional(t.String()),
        dockerfileContent: t.Optional(t.String()),
        domain: t.Optional(t.String()),
        internalPort: t.Optional(t.Number()),
        webhookEnabled: t.Optional(t.Boolean()),
      }),
    }
  )
  .delete(
    "/:id",
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

      // Cleanup proxy
      if (service.domain) {
        await caddyService.removeRoute(service.domain);
      }

      // Cleanup container
      if (service.currentContainerId) {
        try {
          await dockerService.stopContainer(service.currentContainerId);
          await dockerService.removeContainer(service.currentContainerId);
        } catch (e) {
          console.warn("Cleanup container failed:", e);
        }
      }

      await db.delete(schema.services).where(eq(schema.services.id, params.id));

      return { success: true };
    },
    {
      requireRole: "admin",
    }
  )
  .post(
    "/:id/env",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      // Upsert env vars: delete existing matching keys, then insert
      for (const item of body.variables) {
        await db
          .delete(schema.envVars)
          .where(and(eq(schema.envVars.serviceId, service.id), eq(schema.envVars.key, item.key)));

        await db.insert(schema.envVars).values({
          serviceId: service.id,
          key: item.key,
          value: item.value,
          isSecret: item.isSecret ?? false,
        });
      }

      return { success: true };
    },
    {
      requireRole: "developer",
      body: t.Object({
        variables: t.Array(
          t.Object({
            key: t.String(),
            value: t.String(),
            isSecret: t.Optional(t.Boolean()),
          })
        ),
      }),
    }
  )
  .get(
    "/:id/stats",
    async ({ params, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service || !service.currentContainerId) {
        return { running: false, stats: null };
      }

      try {
        const stats = await dockerService.getContainerStats(service.currentContainerId);
        // Calculate CPU & memory percentage
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
        const systemCpuDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
        const onlineCpus = stats.cpu_stats.online_cpus || 1;
        const cpuPercent = systemCpuDelta > 0 ? (cpuDelta / systemCpuDelta) * onlineCpus * 100 : 0;

        const memoryUsage = stats.memory_stats.usage || 0;
        const memoryLimit = stats.memory_stats.limit || 1;
        const memoryPercent = (memoryUsage / memoryLimit) * 100;

        return {
          running: true,
          stats: {
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            memoryBytes: memoryUsage,
            memoryLimitBytes: memoryLimit,
            memoryPercent: Math.round(memoryPercent * 100) / 100,
          },
        };
      } catch (err) {
        return { running: false, error: (err as any).message };
      }
    },
    {
      requireRole: "viewer",
    }
  )
  .get(
    "/:id/containers",
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

      if (service.type === "compose") {
        const projectName = `${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
        const containers = await dockerService.getProjectContainers(projectName);
        return { containers };
      } else {
        // Dockerfile service
        if (!service.currentContainerId) {
          return { containers: [] };
        }
        try {
          const container = dockerService.getContainer(service.currentContainerId);
          const info = await container.inspect();
          return {
            containers: [
              {
                id: info.Id,
                name: info.Name.replace(/^\//, ""),
                service: service.name,
                state: info.State.Status,
              },
            ],
          };
        } catch {
          return { containers: [] };
        }
      }
    },
    {
      requireRole: "viewer",
    }
  )
  .post(
    "/:id/env/auto-detect",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      const rawCompose = (body as any)?.composeContent || service.composeContent;
      if (!rawCompose || !rawCompose.trim()) {
        return {
          detected: 0,
          added: 0,
          skipped: 0,
          message: "No Compose content provided to analyze",
          variables: [],
        };
      }

      const extracted = extractComposeEnvVars(rawCompose);
      const existing = await db
        .select()
        .from(schema.envVars)
        .where(eq(schema.envVars.serviceId, service.id));

      const existingKeys = new Set(existing.map((e) => e.key));
      let addedCount = 0;
      let skippedCount = 0;

      for (const item of extracted) {
        if (!existingKeys.has(item.key)) {
          await db.insert(schema.envVars).values({
            serviceId: service.id,
            key: item.key,
            value: item.defaultValue,
            isSecret: item.isSecret,
          });
          addedCount++;
          existingKeys.add(item.key);
        } else {
          skippedCount++;
        }
      }

      const allUpdated = await db
        .select()
        .from(schema.envVars)
        .where(eq(schema.envVars.serviceId, service.id));

      return {
        detected: extracted.length,
        added: addedCount,
        skipped: skippedCount,
        variables: allUpdated,
      };
    },
    {
      requireRole: "developer",
      body: t.Optional(
        t.Object({
          composeContent: t.Optional(t.String()),
        })
      ),
    }
  )
  // Deploy Keys Management
  .get(
    "/:id/deploy-key",
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

      return {
        hasKey: Boolean(service.sshPrivateKey),
        publicKey: service.sshPublicKey || null,
      };
    },
    {
      requireRole: "viewer",
    }
  )
  .post(
    "/:id/deploy-key/generate",
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

      const keypair = await gitService.generateDeployKey(`dilly-${service.name}@dilly.dev`);

      await db
        .update(schema.services)
        .set({
          sshPublicKey: keypair.publicKey,
          sshPrivateKey: keypair.privateKey,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, service.id));

      return {
        success: true,
        publicKey: keypair.publicKey,
      };
    },
    {
      requireRole: "admin",
    }
  )
  .post(
    "/:id/deploy-key/custom",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      await db
        .update(schema.services)
        .set({
          sshPublicKey: body.publicKey || "custom-ssh-key",
          sshPrivateKey: body.privateKey,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, service.id));

      return {
        success: true,
        publicKey: body.publicKey || "custom-ssh-key",
      };
    },
    {
      requireRole: "admin",
      body: t.Object({
        privateKey: t.String(),
        publicKey: t.Optional(t.String()),
      }),
    }
  )
  .delete(
    "/:id/deploy-key",
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

      await db
        .update(schema.services)
        .set({
          sshPublicKey: null,
          sshPrivateKey: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.services.id, service.id));

      return { success: true };
    },
    {
      requireRole: "admin",
    }
  )
  // Webhook Management
  .get(
    "/:id/webhook",
    async ({ params, user, set, request }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      let secret = service.webhookSecret;
      if (!secret) {
        secret = crypto.randomBytes(24).toString("hex");
        await db
          .update(schema.services)
          .set({ webhookSecret: secret })
          .where(eq(schema.services.id, service.id));
      }

      const host = request.headers.get("host") || "localhost:3333";
      const protocol = request.headers.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
      const webhookUrl = `${protocol}://${host}/api/webhooks/deploy/${service.id}`;

      return {
        webhookUrl,
        webhookSecret: secret,
        webhookEnabled: service.webhookEnabled,
      };
    },
    {
      requireRole: "viewer",
    }
  )
  .post(
    "/:id/webhook/regenerate-secret",
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

      const newSecret = crypto.randomBytes(24).toString("hex");
      await db
        .update(schema.services)
        .set({ webhookSecret: newSecret, updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      return {
        success: true,
        webhookSecret: newSecret,
      };
    },
    {
      requireRole: "admin",
    }
  )
  .patch(
    "/:id/webhook",
    async ({ params, body, user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, params.id));
      if (!service) {
        set.status = 404;
        return { error: "Service not found" };
      }

      await db
        .update(schema.services)
        .set({ webhookEnabled: body.enabled, updatedAt: new Date() })
        .where(eq(schema.services.id, service.id));

      return {
        success: true,
        webhookEnabled: body.enabled,
      };
    },
    {
      requireRole: "admin",
      body: t.Object({
        enabled: t.Boolean(),
      }),
    }
  )
  .post(
    "/:id/webhook/test",
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

      try {
        const result = await runDeployment(service.id, {
          triggeredBy: "webhook",
          commitHash: "test-" + crypto.randomBytes(4).toString("hex"),
          commitMessage: `Test webhook simulation triggered by ${user.name}`,
          user: { name: user.name, role: user.role },
        });

        return {
          success: true,
          message: "Simulated webhook push deployment triggered",
          deploymentId: result.deploymentId,
        };
      } catch (err: any) {
        set.status = 500;
        return { error: err.message };
      }
    },
    {
      requireRole: "developer",
    }
  );

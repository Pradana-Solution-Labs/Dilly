import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { dockerService } from "../services/docker.js";

export const logsRoutes = new Elysia({ prefix: "/api/services" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    })
  )
  .ws("/:id/logs/ws", {
    query: t.Object({
      token: t.Optional(t.String()),
      containerId: t.Optional(t.String()),
      tail: t.Optional(t.String()),
    }),
    async open(ws) {
      const { id } = ws.data.params;
      const { token, containerId: requestedContainer, tail = "100" } = ws.data.query;

      // Authenticate
      if (!token) {
        ws.send(JSON.stringify({ type: "error", error: "Authentication token required" }));
        ws.close();
        return;
      }

      const payload = await ws.data.jwt.verify(token);
      if (!payload) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid token" }));
        ws.close();
        return;
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, id));
      if (!service) {
        ws.send(JSON.stringify({ type: "error", error: "Service not found" }));
        ws.close();
        return;
      }

      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, service.projectId));

      // Resolve target container ID
      let targetContainerId = requestedContainer;
      if (!targetContainerId) {
        if (service.type === "compose") {
          const projectName = `${project.name}_${service.name}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
          const containers = await dockerService.getProjectContainers(projectName);
          if (containers.length > 0) {
            targetContainerId = containers[0].id;
          }
        } else {
          targetContainerId = service.currentContainerId ?? undefined;
        }
      }

      if (!targetContainerId) {
        ws.send(
          JSON.stringify({
            type: "system",
            data: "[Dilly] Service is not running or no active container found.\r\n",
          })
        );
        return;
      }

      ws.send(
        JSON.stringify({
          type: "system",
          data: `[Dilly] Connected to log stream for container ${targetContainerId.substring(0, 12)}...\r\n`,
        })
      );

      try {
        const cleanup = await dockerService.streamContainerLogs(
          targetContainerId,
          tail === "all" ? "all" : Number(tail) || 100,
          (chunk) => {
            try {
              ws.send(JSON.stringify({ type: "log", data: chunk }));
            } catch {}
          }
        );

        // Store cleanup on ws connection
        (ws as any)._cleanup = cleanup;
      } catch (err: any) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: `Failed to stream logs: ${err.message}`,
          })
        );
      }
    },
    close(ws) {
      if ((ws as any)._cleanup) {
        (ws as any)._cleanup();
      }
    },
  });

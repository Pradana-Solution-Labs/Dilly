import { Elysia, t } from "elysia";
import { jwt } from "@elysiajs/jwt";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { dockerService } from "../services/docker.js";

export const terminalRoutes = new Elysia({ prefix: "/api/services" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
    })
  )
  .ws("/:id/terminal/ws", {
    query: t.Object({
      token: t.Optional(t.String()),
      containerId: t.Optional(t.String()),
    }),
    async open(ws) {
      const { id } = ws.data.params;
      const { token, containerId: requestedContainer } = ws.data.query;

      // Authenticate
      if (!token) {
        ws.send("\r\n\x1b[31m[Dilly] Authentication token required.\x1b[0m\r\n");
        ws.close();
        return;
      }

      const payload = await ws.data.jwt.verify(token);
      if (!payload) {
        ws.send("\r\n\x1b[31m[Dilly] Invalid authentication token.\x1b[0m\r\n");
        ws.close();
        return;
      }

      const [service] = await db.select().from(schema.services).where(eq(schema.services.id, id));
      if (!service) {
        ws.send("\r\n\x1b[31m[Dilly] Service not found.\x1b[0m\r\n");
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
          "\r\n\x1b[33m[Dilly] No active running container found for this service. Please deploy or start the service first.\x1b[0m\r\n"
        );
        ws.close();
        return;
      }

      try {
        const session = await dockerService.createTerminalSession(targetContainerId);
        (ws as any)._terminalSession = session;

        ws.send(`\r\n\x1b[32m[Dilly] Attached to terminal in container ${targetContainerId.substring(0, 12)}.\x1b[0m\r\n\r\n`);

        session.stream.on("data", (chunk: Buffer) => {
          try {
            ws.send(chunk.toString("utf-8"));
          } catch {}
        });

        session.stream.on("end", () => {
          try {
            ws.send("\r\n\x1b[33m[Dilly] Terminal session ended.\x1b[0m\r\n");
            ws.close();
          } catch {}
        });

        session.stream.on("error", (err: any) => {
          try {
            ws.send(`\r\n\x1b[31m[Dilly] Terminal error: ${err.message}\x1b[0m\r\n`);
          } catch {}
        });
      } catch (err: any) {
        ws.send(`\r\n\x1b[31m[Dilly] Failed to start terminal: ${err.message}\x1b[0m\r\n`);
        ws.close();
      }
    },
    message(ws, message) {
      const session = (ws as any)._terminalSession;
      if (!session || !session.stream) return;

      try {
        // If message is JSON event (e.g. input or resize)
        if (typeof message === "string" && message.startsWith("{") && message.endsWith("}")) {
          const parsed = JSON.parse(message);
          if (parsed.type === "input" && typeof parsed.data === "string") {
            session.stream.write(parsed.data);
            return;
          }
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            session.resize(parsed.cols, parsed.rows);
            return;
          }
        }

        // Direct keystroke string fallback
        session.stream.write(String(message));
      } catch (err) {
        console.warn("[Terminal] Write error:", err);
      }
    },
    close(ws) {
      const session = (ws as any)._terminalSession;
      if (session && session.stream) {
        try {
          session.stream.end();
          if (typeof session.stream.destroy === "function") {
            session.stream.destroy();
          }
        } catch {}
      }
    },
  });

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { serviceRoutes } from "./routes/services.js";
import { deployRoutes } from "./routes/deploy.js";
import { proxyRoutes } from "./routes/proxy.js";
import { logsRoutes } from "./routes/logs.js";
import { terminalRoutes } from "./routes/terminal.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { dockerService } from "./services/docker.js";
import { caddyService } from "./services/caddy.js";
import path from "path";
import fs from "fs";

const webDistPath = path.resolve(import.meta.dir, "../../web/dist");

const staticPlugin = new Elysia();
if (fs.existsSync(webDistPath)) {
  staticPlugin
    .get("/assets/*", ({ path: reqPath }) => {
      const filePath = path.join(webDistPath, reqPath);
      return Bun.file(filePath);
    })
    .get("/favicon.svg", () => Bun.file(path.join(webDistPath, "favicon.svg")))
    .get("/icons.svg", () => Bun.file(path.join(webDistPath, "icons.svg")))
    .get("/", () => Bun.file(path.join(webDistPath, "index.html")))
    .get("/login", () => Bun.file(path.join(webDistPath, "index.html")))
    .get("/dashboard", () => Bun.file(path.join(webDistPath, "index.html")))
    .get("/projects/*", () => Bun.file(path.join(webDistPath, "index.html")))
    .get("/services/*", () => Bun.file(path.join(webDistPath, "index.html")))
    .get("/settings", () => Bun.file(path.join(webDistPath, "index.html")));
}

const app = new Elysia()
  .use(cors())
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Dilly PaaS API",
          version: "0.1.0",
          description: "Lean self-hosted PaaS platform API",
        },
      },
    })
  )
  .get("/health", async () => {
    const dockerLive = await dockerService.ping();
    const caddyLive = await caddyService.ping();

    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        docker: dockerLive ? "connected" : "disconnected",
        caddy: caddyLive ? "connected" : "disconnected",
      },
    };
  })
  .use(authRoutes)
  .use(projectRoutes)
  .use(serviceRoutes)
  .use(deployRoutes)
  .use(proxyRoutes)
  .use(logsRoutes)
  .use(terminalRoutes)
  .use(webhookRoutes)
  .use(staticPlugin);

// Startup initialization
async function bootstrap() {
  console.log(`[Dilly] Initializing core engine...`);

  // Verify Docker socket
  const dockerOk = await dockerService.ping();
  if (dockerOk) {
    console.log(`[Docker] Connected to Docker Engine.`);
    await dockerService.ensureNetwork();
    try {
      const caddyContainer = dockerService.getContainer("dilly-caddy");
      const info = await caddyContainer.inspect();
      if (!info.NetworkSettings.Networks["dilly-net"]) {
        const net = (dockerService as any).docker.getNetwork("dilly-net");
        await net.connect({ Container: "dilly-caddy" });
        console.log(`[Docker] Connected dilly-caddy to dilly-net.`);
      }
    } catch {}
  } else {
    console.warn(`[Docker] Note: Docker socket unreachable at ${config.dockerHost || "default"}. Ensure Docker engine is active.`);
  }

  // Initialize Caddy Server config
  await caddyService.initializeServer();

  app.listen(config.port, () => {
    console.log(`[Dilly] Server running on http://localhost:${config.port}`);
    console.log(`[Dilly] Swagger Docs available on http://localhost:${config.port}/swagger`);
  });
}

bootstrap().catch((err) => {
  console.error("[Dilly] Startup error:", err);
});

export type App = typeof app;

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { serviceRoutes } from "./routes/services.js";
import { deployRoutes } from "./routes/deploy.js";
import { proxyRoutes } from "./routes/proxy.js";
import { dockerService } from "./services/docker.js";
import { caddyService } from "./services/caddy.js";
import path from "path";
import fs from "fs";

const webDistPath = path.resolve(import.meta.dir, "../../web/dist");

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
  .use(proxyRoutes);

// Static file serving for Svelte SPA
if (fs.existsSync(webDistPath)) {
  // Static assets directly from /assets/
  app.get("/assets/*", ({ path: reqPath }) => {
    const filePath = path.join(webDistPath, reqPath);
    return Bun.file(filePath);
  });

  // Favicon & root SVG assets
  app.get("/favicon.svg", () => Bun.file(path.join(webDistPath, "favicon.svg")));
  app.get("/icons.svg", () => Bun.file(path.join(webDistPath, "icons.svg")));

  // Client-side routes fallback to index.html
  app.get("/", () => Bun.file(path.join(webDistPath, "index.html")));
  app.get("/login", () => Bun.file(path.join(webDistPath, "index.html")));
  app.get("/dashboard", () => Bun.file(path.join(webDistPath, "index.html")));
  app.get("/projects/*", () => Bun.file(path.join(webDistPath, "index.html")));
  app.get("/services/*", () => Bun.file(path.join(webDistPath, "index.html")));
  app.get("/settings", () => Bun.file(path.join(webDistPath, "index.html")));
}

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

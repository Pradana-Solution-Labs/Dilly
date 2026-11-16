import Docker from "dockerode";
import { config } from "../config.js";

class DockerManager {
  private docker: Docker;
  public defaultNetwork: string = "dilly-net";

  constructor() {
    if (config.dockerHost) {
      if (config.dockerHost.startsWith("unix://")) {
        this.docker = new Docker({ socketPath: config.dockerHost.replace("unix://", "") });
      } else if (config.dockerHost.startsWith("npipe://")) {
        this.docker = new Docker({ socketPath: config.dockerHost.replace("npipe://", "") });
      } else {
        const url = new URL(config.dockerHost);
        this.docker = new Docker({ host: url.hostname, port: Number(url.port) || 2375 });
      }
    } else {
      // Auto-detect platform default
      if (process.platform === "win32") {
        this.docker = new Docker({ socketPath: "//./pipe/docker_engine" });
      } else {
        this.docker = new Docker({ socketPath: "/var/run/docker.sock" });
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<any> {
    return this.docker.version();
  }

  async ensureNetwork(networkName = this.defaultNetwork): Promise<void> {
    const networks = await this.docker.listNetworks();
    const exists = networks.some((n) => n.Name === networkName);
    if (!exists) {
      await this.docker.createNetwork({
        Name: networkName,
        Driver: "bridge",
        CheckDuplicate: true,
      });
    }
  }

  async listContainers(all = true): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({ all });
  }

  getContainer(id: string): Docker.Container {
    return this.docker.getContainer(id);
  }

  async startContainer(id: string): Promise<void> {
    const container = this.getContainer(id);
    await container.start();
  }

  async stopContainer(id: string, timeout = 10): Promise<void> {
    const container = this.getContainer(id);
    await container.stop({ t: timeout });
  }

  async restartContainer(id: string, timeout = 10): Promise<void> {
    const container = this.getContainer(id);
    await container.restart({ t: timeout });
  }

  async removeContainer(id: string, force = true): Promise<void> {
    const container = this.getContainer(id);
    await container.remove({ force });
  }

  async getContainerLogs(id: string, tail: number | "all" = 200): Promise<NodeJS.ReadableStream> {
    const container = this.getContainer(id);
    return container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: tail === "all" ? undefined : tail,
      timestamps: true,
    }) as unknown as NodeJS.ReadableStream;
  }

  async getContainerStats(id: string): Promise<any> {
    const container = this.getContainer(id);
    return container.stats({ stream: false });
  }

  async pullImage(image: string, onProgress?: (msg: string) => void): Promise<void> {
    const stream = await this.docker.pull(image);
    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: any, res: any) => (err ? reject(err) : resolve(res)),
        (event: any) => {
          if (onProgress && event) {
            const status = event.status || "";
            const progress = event.progress || "";
            onProgress(`${status} ${progress}\n`.trim() + "\n");
          }
        }
      );
    });
  }

  async ensureImage(image: string, onProgress?: (msg: string) => void): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      if (onProgress) onProgress(`[Docker] Pulling image ${image}...\n`);
      await this.pullImage(image, onProgress);
      if (onProgress) onProgress(`[Docker] Image ${image} ready.\n`);
    }
  }

  async runContainer(opts: {
    image: string;
    name: string;
    env?: Record<string, string>;
    network?: string;
    labels?: Record<string, string>;
    exposedPort?: number;
    onProgress?: (msg: string) => void;
  }): Promise<Docker.Container> {
    const networkName = opts.network || this.defaultNetwork;
    await this.ensureNetwork(networkName);
    await this.ensureImage(opts.image, opts.onProgress);

    const envArray = opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : [];

    const container = await this.docker.createContainer({
      Image: opts.image,
      name: opts.name,
      Env: envArray,
      Labels: {
        "dilly.managed": "true",
        ...opts.labels,
      },
      HostConfig: {
        NetworkMode: networkName,
        RestartPolicy: {
          Name: "unless-stopped",
        },
      },
    });

    await container.start();
    return container;
  }

  /**
   * Retrieves all containers belonging to a Compose project or service name
   */
  async getProjectContainers(projectName: string): Promise<Array<{ id: string; name: string; service: string; state: string }>> {
    try {
      const normalized = projectName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: [`com.docker.compose.project=${normalized}`],
        },
      });

      return containers.map((c) => ({
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, "") || c.Id.substring(0, 12),
        service: c.Labels["com.docker.compose.service"] || "app",
        state: c.State,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Streams live logs from a container, automatically demuxing stdout/stderr
   */
  async streamContainerLogs(
    containerId: string,
    tail: number | "all" = 100,
    onData: (chunk: string) => void
  ): Promise<() => void> {
    const container = this.getContainer(containerId);
    const info = await container.inspect();
    const hasTty = Boolean(info.Config?.Tty);

    const logStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: tail === "all" ? undefined : tail,
      timestamps: true,
    })) as unknown as NodeJS.ReadableStream;

    if (hasTty) {
      logStream.on("data", (chunk: Buffer) => {
        onData(chunk.toString("utf-8"));
      });
    } else {
      const { PassThrough } = await import("stream");
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on("data", (chunk: Buffer) => onData(chunk.toString("utf-8")));
      stderr.on("data", (chunk: Buffer) => onData(chunk.toString("utf-8")));

      this.docker.modem.demuxStream(logStream, stdout, stderr);
    }

    return () => {
      try {
        if ("destroy" in logStream && typeof (logStream as any).destroy === "function") {
          (logStream as any).destroy();
        }
      } catch {}
    };
  }

  /**
   * Spawns an interactive TTY exec session in the container
   */
  async createTerminalSession(containerId: string): Promise<{
    stream: NodeJS.ReadWriteStream;
    exec: Docker.Exec;
    resize: (cols: number, rows: number) => Promise<void>;
  }> {
    const container = this.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", "[ -x /bin/bash ] && exec /bin/bash || exec /bin/sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const stream = (await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    })) as unknown as NodeJS.ReadWriteStream;

    return {
      stream,
      exec,
      resize: async (cols: number, rows: number) => {
        try {
          await exec.resize({ w: cols, h: rows });
        } catch {}
      },
    };
  }
}

export const dockerService = new DockerManager();

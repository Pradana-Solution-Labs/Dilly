import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

export interface ComposeExecutionResult {
  success: boolean;
  exitCode: number | null;
  output: string;
}

class ComposeManager {
  /**
   * Executes a docker compose command inside a specific directory with environment variables
   */
  async runCommand(
    projectDir: string,
    projectName: string,
    args: string[],
    envVars: Record<string, string> = {},
    onLog?: (chunk: string) => void
  ): Promise<ComposeExecutionResult> {
    const fullArgs = ["compose", "-p", projectName, ...args];

    return new Promise((resolve) => {
      const child = spawn("docker", fullArgs, {
        cwd: projectDir,
        env: {
          ...process.env,
          ...envVars,
          COMPOSE_PROJECT_NAME: projectName,
        },
        shell: true,
      });

      let output = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        output += text;
        if (onLog) onLog(text);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        output += text;
        if (onLog) onLog(text);
      });

      child.on("close", (code) => {
        resolve({
          success: code === 0,
          exitCode: code,
          output,
        });
      });

      child.on("error", (err) => {
        const text = `Failed to spawn docker compose: ${err.message}\n`;
        output += text;
        if (onLog) onLog(text);
        resolve({
          success: false,
          exitCode: -1,
          output,
        });
      });
    });
  }

  async up(
    projectDir: string,
    projectName: string,
    envVars: Record<string, string> = {},
    onLog?: (chunk: string) => void
  ): Promise<ComposeExecutionResult> {
    return this.runCommand(
      projectDir,
      projectName,
      ["up", "-d", "--build", "--remove-orphans"],
      envVars,
      onLog
    );
  }

  async down(projectDir: string, projectName: string): Promise<ComposeExecutionResult> {
    return this.runCommand(projectDir, projectName, ["down"]);
  }

  async restart(projectDir: string, projectName: string): Promise<ComposeExecutionResult> {
    return this.runCommand(projectDir, projectName, ["restart"]);
  }

  async ps(projectDir: string, projectName: string): Promise<any[]> {
    const res = await this.runCommand(projectDir, projectName, ["ps", "--format", "json"]);
    if (!res.success || !res.output.trim()) return [];
    try {
      // docker compose ps --format json outputs line-delimited JSON objects
      return res.output
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Helper to write a compose file to a directory
   */
  async writeComposeFile(projectDir: string, content: string, filename = "docker-compose.yml"): Promise<string> {
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, filename);
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }
}

export const composeService = new ComposeManager();

import { spawn, execFile } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { config } from "../config.js";

export interface GitCloneResult {
  success: boolean;
  commitHash: string;
  commitMessage: string;
  output: string;
}

export interface SSHKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface WebhookEventInfo {
  isPing: boolean;
  isPush: boolean;
  branch: string | null;
  commitHash: string | null;
  commitMessage: string | null;
  pusher: string;
}

class GitManager {
  /**
   * Generates a modern Ed25519 SSH keypair suitable for GitHub/GitLab deploy keys
   */
  async generateDeployKey(comment = "dilly-deploy-key@dilly.dev"): Promise<SSHKeyPair> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dilly-ssh-"));
    const keyPath = path.join(tempDir, "id_ed25519");

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "ssh-keygen",
          ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath],
          (err) => {
            if (err) return reject(err);
            resolve();
          }
        );
      });

      const privateKey = await fs.readFile(keyPath, "utf-8");
      const publicKey = (await fs.readFile(`${keyPath}.pub`, "utf-8")).trim();

      return { publicKey, privateKey };
    } catch {
      // Fallback: Node.js crypto generation if ssh-keygen binary is not in PATH
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      // Wire-format OpenSSH public key for Ed25519
      const rawPub = publicKey.export({ type: "spki", format: "der" });
      const rawKey = rawPub.subarray(12); // Ed25519 raw pubkey is the last 32 bytes of SPKI DER
      const typeStr = "ssh-ed25519";
      const buf = Buffer.alloc(4 + typeStr.length + 4 + 32);
      let offset = 0;
      buf.writeUInt32BE(typeStr.length, offset);
      offset += 4;
      buf.write(typeStr, offset, "ascii");
      offset += typeStr.length;
      buf.writeUInt32BE(32, offset);
      offset += 4;
      rawKey.copy(buf, offset);
      const openSshPub = `ssh-ed25519 ${buf.toString("base64")} ${comment}`;

      return {
        publicKey: openSshPub,
        privateKey,
      };
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  }

  /**
   * Writes the SSH private key to disk with strict secure permissions (0600 / icacls)
   */
  async prepareSshKeyFile(serviceId: string, privateKey: string): Promise<string> {
    const keysDir = path.resolve(config.dataDir, "keys", serviceId);
    await fs.mkdir(keysDir, { recursive: true });
    const keyFile = path.join(keysDir, "id_ed25519");

    // Ensure line endings are LF
    const normalizedKey = privateKey.replace(/\r\n/g, "\n").trim() + "\n";
    await fs.writeFile(keyFile, normalizedKey, { encoding: "utf-8" });

    // Apply strict permissions required by OpenSSH
    if (process.platform === "win32") {
      try {
        const username = process.env.USERNAME || "SYSTEM";
        await new Promise<void>((resolve, reject) => {
          execFile("icacls", [keyFile, "/inheritance:r", "/grant:r", `${username}:(R)`], (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      } catch (err) {
        console.warn("[Git] Could not set Windows icacls on key:", err);
      }
    } else {
      try {
        await fs.chmod(keyFile, 0o600);
      } catch (err) {
        console.warn("[Git] Could not chmod 0600 on key:", err);
      }
    }

    return keyFile;
  }

  /**
   * Executes a git command in the target directory
   */
  private runGit(
    args: string[],
    cwd: string,
    sshKeyPath?: string,
    onLog?: (chunk: string) => void
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env = { ...process.env };

      if (sshKeyPath) {
        // StrictHostKeyChecking=accept-new automatically accepts new host fingerprints without user prompt
        const formattedKeyPath = process.platform === "win32" ? sshKeyPath.replace(/\\/g, "/") : sshKeyPath;
        env.GIT_SSH_COMMAND = `ssh -i "${formattedKeyPath}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
      }

      const child = spawn("git", args, {
        cwd,
        env,
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        const text = data.toString();
        stdout += text;
        if (onLog) onLog(text);
      });

      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderr += text;
        if (onLog) onLog(text);
      });

      child.on("close", (code) => {
        resolve({ code: code || 0, stdout, stderr });
      });

      child.on("error", (err) => {
        const text = `Failed to execute git: ${err.message}\n`;
        stderr += text;
        if (onLog) onLog(text);
        resolve({ code: -1, stdout, stderr });
      });
    });
  }

  /**
   * Clones or pulls a repository into targetDir
   */
  async cloneOrPull(opts: {
    serviceId: string;
    repoUrl: string;
    branch?: string;
    targetDir: string;
    privateKey?: string | null;
    onLog?: (chunk: string) => void;
  }): Promise<GitCloneResult> {
    const branch = opts.branch || "main";
    let output = "";
    const log = (msg: string) => {
      output += msg;
      if (opts.onLog) opts.onLog(msg);
    };

    let sshKeyPath: string | undefined;
    if (opts.privateKey && opts.privateKey.trim()) {
      log(`[Git] Preparing SSH Deploy Key for ${opts.serviceId}...\n`);
      sshKeyPath = await this.prepareSshKeyFile(opts.serviceId, opts.privateKey);
    }

    await fs.mkdir(opts.targetDir, { recursive: true });
    const isGitRepo = fsSync.existsSync(path.join(opts.targetDir, ".git"));

    if (isGitRepo) {
      log(`[Git] Existing repository detected. Fetching latest changes for branch '${branch}'...\n`);
      await this.runGit(["remote", "set-url", "origin", opts.repoUrl], opts.targetDir, sshKeyPath, log);

      const fetchRes = await this.runGit(["fetch", "origin", branch], opts.targetDir, sshKeyPath, log);
      if (fetchRes.code !== 0) {
        return {
          success: false,
          commitHash: "",
          commitMessage: "",
          output,
        };
      }

      const checkoutRes = await this.runGit(["checkout", branch], opts.targetDir, sshKeyPath, log);
      if (checkoutRes.code !== 0) {
        log(`[Git] Checkout branch failed, attempting checkout -B ${branch} origin/${branch}...\n`);
        await this.runGit(["checkout", "-B", branch, `origin/${branch}`], opts.targetDir, sshKeyPath, log);
      }

      const pullRes = await this.runGit(["pull", "origin", branch], opts.targetDir, sshKeyPath, log);
      if (pullRes.code !== 0) {
        return {
          success: false,
          commitHash: "",
          commitMessage: "",
          output,
        };
      }
    } else {
      log(`[Git] Cloning repository ${opts.repoUrl} (branch: ${branch})...\n`);
      // Clone into targetDir
      const cloneRes = await this.runGit(
        ["clone", "--branch", branch, "--depth", "1", opts.repoUrl, "."],
        opts.targetDir,
        sshKeyPath,
        log
      );

      if (cloneRes.code !== 0) {
        return {
          success: false,
          commitHash: "",
          commitMessage: "",
          output,
        };
      }
    }

    // Inspect commit SHA and commit message
    const shaRes = await this.runGit(["rev-parse", "HEAD"], opts.targetDir, undefined);
    const commitHash = shaRes.stdout.trim() || "";

    const msgRes = await this.runGit(["log", "-1", "--pretty=%B"], opts.targetDir, undefined);
    const commitMessage = msgRes.stdout.trim() || "";

    log(`[Git] Synchronized at commit ${commitHash.substring(0, 7)}: "${commitMessage.split("\n")[0]}"\n`);

    return {
      success: true,
      commitHash,
      commitMessage,
      output,
    };
  }

  /**
   * Verifies GitHub HMAC-SHA256 signature (X-Hub-Signature-256)
   */
  verifyGitHubSignature(secret: string, signatureHeader: string | undefined, rawBody: string): boolean {
    if (!signatureHeader || !secret) return false;

    try {
      const hmac = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const sigBuffer = Buffer.from(signatureHeader);
      const hmacBuffer = Buffer.from(hmac);

      if (sigBuffer.length !== hmacBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, hmacBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Parses webhook payloads across GitHub, GitLab, and generic webhooks
   */
  parseWebhookPayload(headers: Record<string, string | undefined>, body: any): WebhookEventInfo {
    const ghEvent = headers["x-github-event"];
    const glEvent = headers["x-gitlab-event"];

    // GitHub Ping
    if (ghEvent === "ping") {
      return {
        isPing: true,
        isPush: false,
        branch: null,
        commitHash: null,
        commitMessage: null,
        pusher: "GitHub",
      };
    }

    // GitHub Push
    if (ghEvent === "push" || body?.ref?.startsWith("refs/heads/")) {
      const ref = body?.ref || "";
      const branch = ref.replace(/^refs\/heads\//, "");
      const commit = body?.head_commit || body?.commits?.[0];
      const commitHash = commit?.id || body?.after || null;
      const commitMessage = commit?.message || null;
      const pusher = body?.pusher?.name || body?.sender?.login || "GitHub";

      return {
        isPing: false,
        isPush: true,
        branch,
        commitHash,
        commitMessage,
        pusher,
      };
    }

    // GitLab Push
    if (glEvent === "Push Hook" || body?.object_kind === "push") {
      const ref = body?.ref || "";
      const branch = ref.replace(/^refs\/heads\//, "");
      const commitHash = body?.checkout_sha || body?.after || null;
      const commitMessage = body?.commits?.[0]?.message || null;
      const pusher = body?.user_name || body?.user_username || "GitLab";

      return {
        isPing: false,
        isPush: true,
        branch,
        commitHash,
        commitMessage,
        pusher,
      };
    }

    // Generic webhook payload
    const branch = body?.branch || null;
    const commitHash = body?.commitHash || body?.commit || null;
    const commitMessage = body?.commitMessage || body?.message || null;
    const pusher = body?.author || body?.pusher || "Webhook";

    return {
      isPing: false,
      isPush: true,
      branch,
      commitHash,
      commitMessage,
      pusher,
    };
  }
}

export const gitService = new GitManager();

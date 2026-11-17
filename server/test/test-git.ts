import { gitService } from "../src/services/git.js";

async function test() {
  console.log("Testing GitService...");

  // 1. Generate Deploy Key
  const key = await gitService.generateDeployKey("dilly-test-key");
  console.log("Generated Key:", key.publicKey.substring(0, 40) + "...");
  if (!key.publicKey.startsWith("ssh-ed25519 ")) {
    throw new Error("Invalid public key format!");
  }
  if (!key.privateKey.includes("PRIVATE KEY-----")) {
    throw new Error("Invalid private key format!");
  }
  console.log("Keygen OK!");

  // 2. Test GitHub HMAC
  const secret = "my-secret-token";
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const crypto = await import("crypto");
  const validSig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const isValid = gitService.verifyGitHubSignature(secret, validSig, body);
  const isInvalid = gitService.verifyGitHubSignature(secret, "sha256=invalid", body);
  console.log("Valid HMAC verified:", isValid);
  console.log("Invalid HMAC rejected:", !isInvalid);
  if (!isValid || isInvalid) throw new Error("HMAC verification failed!");

  // 3. Test Webhook parser
  const parsedGh = gitService.parseWebhookPayload(
    { "x-github-event": "push" },
    {
      ref: "refs/heads/main",
      head_commit: { id: "abcdef123456", message: "feat: push to deploy" },
      pusher: { name: "developer" },
    }
  );
  console.log("Parsed GitHub:", parsedGh);
  if (parsedGh.branch !== "main" || parsedGh.commitHash !== "abcdef123456") {
    throw new Error("Webhook parse failed!");
  }

  console.log("All GitService unit tests PASSED!");
}

test().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});

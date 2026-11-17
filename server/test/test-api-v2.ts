import crypto from "crypto";

async function run() {
  const baseUrl = "http://127.0.0.1:3333";
  console.log("Testing Dilly API at", baseUrl);

  // 1. Health check
  const healthRes = await fetch(`${baseUrl}/health`);
  const health = await healthRes.json();
  console.log("Health:", health);
  if (health.status !== "healthy") throw new Error("Health check failed");

  // 2. Login
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@dilly.dev", password: "password123" }),
  });
  const loginData = await loginRes.json();
  const token = loginData.token;
  console.log("Logged in as:", loginData.user.name, `(${loginData.user.role})`);

  // 3. Get projects & services
  const projectsRes = await fetch(`${baseUrl}/api/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const projects = await projectsRes.json();
  const firstProject = projects[0];
  const fullProjectRes = await fetch(`${baseUrl}/api/projects/${firstProject.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const fullProject = await fullProjectRes.json();
  const service = fullProject.services[0];
  console.log("Target Service:", service.name, `(${service.id})`);

  // 4. Test Deploy Key generation
  console.log("\n--- Testing SSH Deploy Key ---");
  const genKeyRes = await fetch(`${baseUrl}/api/services/${service.id}/deploy-key/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const genKeyData = await genKeyRes.json();
  console.log("Generated Key:", genKeyData.publicKey.substring(0, 45) + "...");
  if (!genKeyData.publicKey.startsWith("ssh-ed25519 ")) {
    throw new Error("Key generation did not return valid OpenSSH Ed25519 key");
  }

  const getKeyRes = await fetch(`${baseUrl}/api/services/${service.id}/deploy-key`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const getKeyData = await getKeyRes.json();
  console.log("Deploy Key Status:", getKeyData.hasKey ? "Key Active" : "No Key");
  if (!getKeyData.hasKey) throw new Error("Key not persisted");

  // 5. Test Webhook Info & Regeneration
  console.log("\n--- Testing Webhook Management ---");
  const hookRes = await fetch(`${baseUrl}/api/services/${service.id}/webhook`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const hookData = await hookRes.json();
  console.log("Webhook URL:", hookData.webhookUrl);
  console.log("Webhook Secret:", hookData.webhookSecret.substring(0, 8) + "...");
  console.log("Webhook Enabled:", hookData.webhookEnabled);

  // 6. Test External Webhook Endpoint: GitHub Ping Event
  console.log("\n--- Testing External Webhook (GitHub Ping) ---");
  const pingPayload = JSON.stringify({ zen: "Responsive is better than fast.", hook_id: 12345 });
  const pingSig = "sha256=" + crypto.createHmac("sha256", hookData.webhookSecret).update(pingPayload).digest("hex");

  const pingRes = await fetch(`${baseUrl}/api/webhooks/deploy/${service.id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "ping",
      "X-Hub-Signature-256": pingSig,
    },
    body: pingPayload,
  });
  const pingData = await pingRes.json();
  console.log("Ping response status:", pingRes.status, pingData);
  if (pingData.status !== "success") throw new Error("GitHub ping failed");

  // 7. Test External Webhook Endpoint: GitHub Push Event
  console.log("\n--- Testing External Webhook (GitHub Push to Deploy) ---");
  const pushPayload = JSON.stringify({
    ref: `refs/heads/${service.gitBranch || "main"}`,
    head_commit: {
      id: "77aa88bb99cc",
      message: "feat: automated webhook push commit",
    },
    pusher: { name: "ci-bot" },
  });
  const pushSig = "sha256=" + crypto.createHmac("sha256", hookData.webhookSecret).update(pushPayload).digest("hex");

  const pushRes = await fetch(`${baseUrl}/api/webhooks/deploy/${service.id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": pushSig,
    },
    body: pushPayload,
  });
  const pushData = await pushRes.json();
  console.log("Push response status:", pushRes.status, pushData);
  if (pushData.status !== "triggered") throw new Error("GitHub push deployment not triggered");

  // 8. Test Invalid Signature Rejection (Security check)
  console.log("\n--- Testing Security: Invalid Signature Rejection ---");
  const badSigRes = await fetch(`${baseUrl}/api/webhooks/deploy/${service.id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": "sha256=invalidhash000000000000000000000000000000000000000000000000000000",
    },
    body: pushPayload,
  });
  console.log("Bad signature response status:", badSigRes.status);
  if (badSigRes.status !== 401) throw new Error("Security check failed: bad signature was not rejected with 401");

  // 9. Check deployment history
  await new Promise((r) => setTimeout(r, 1500));
  const depHistoryRes = await fetch(`${baseUrl}/api/services/${service.id}/deployments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const deployments = await depHistoryRes.json();
  const latest = deployments[0];
  console.log("\n--- Latest Deployment in DB ---");
  console.log("Deployment ID:", latest.id);
  console.log("Status:", latest.status);
  console.log("Triggered By:", latest.triggeredBy);
  console.log("Commit:", latest.commitHash, latest.commitMessage);

  console.log("\nALL VERIFICATIONS PASSED 100%!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

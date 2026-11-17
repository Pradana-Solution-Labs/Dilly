<script lang="ts">
  import { onMount } from 'svelte';
  import { 
    GitBranch, Key, Webhook, Copy, Check, RefreshCw, 
    Play, Shield, ExternalLink, AlertCircle, CheckCircle2, Trash2, Eye, EyeOff
  } from 'lucide-svelte';

  export let service: any;
  export let token: string;
  export let onUpdate: () => void;

  // Form State
  let gitUrl = service?.gitUrl || '';
  let gitBranch = service?.gitBranch || 'main';
  let dockerfilePath = service?.dockerfilePath || 'Dockerfile';
  let composePath = service?.composePath || 'docker-compose.yml';

  let isSavingRepo = false;
  let repoMessage = '';
  let repoMessageType: 'success' | 'error' = 'success';

  // Deploy Key State
  let hasDeployKey = false;
  let publicKey = '';
  let isGeneratingKey = false;
  let keyCopied = false;

  // Webhook State
  let webhookUrl = '';
  let webhookSecret = '';
  let webhookEnabled = true;
  let showSecret = false;
  let urlCopied = false;
  let secretCopied = false;
  let isRegeneratingSecret = false;
  let isTestingWebhook = false;
  let webhookMessage = '';
  let webhookMessageType: 'success' | 'error' = 'success';

  // Active guide tab
  let guideTab: 'github' | 'gitlab' = 'github';

  $: if (service) {
    gitUrl = service.gitUrl || '';
    gitBranch = service.gitBranch || 'main';
    dockerfilePath = service.dockerfilePath || 'Dockerfile';
    composePath = service.composePath || 'docker-compose.yml';
  }

  async function api(path: string, options: RequestInit = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers as any),
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function loadData() {
    if (!service) return;
    try {
      // Load Deploy Key
      const keyData = await api(`/api/services/${service.id}/deploy-key`);
      hasDeployKey = keyData.hasKey;
      publicKey = keyData.publicKey || '';

      // Load Webhook Info
      const hookData = await api(`/api/services/${service.id}/webhook`);
      webhookUrl = hookData.webhookUrl;
      webhookSecret = hookData.webhookSecret;
      webhookEnabled = hookData.webhookEnabled;
    } catch (err: any) {
      console.error('Failed to load git/webhook data:', err);
    }
  }

  async function saveRepoSettings() {
    isSavingRepo = true;
    repoMessage = '';
    try {
      await api(`/api/services/${service.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          gitUrl: gitUrl.trim() || null,
          gitBranch: gitBranch.trim() || 'main',
          ...(service.type === 'compose' ? { composePath } : { dockerfilePath }),
        }),
      });
      repoMessage = 'Repository configuration saved successfully.';
      repoMessageType = 'success';
      onUpdate();
    } catch (err: any) {
      repoMessage = err.message;
      repoMessageType = 'error';
    } finally {
      isSavingRepo = false;
    }
  }

  async function generateDeployKey() {
    isGeneratingKey = true;
    try {
      const res = await api(`/api/services/${service.id}/deploy-key/generate`, { method: 'POST' });
      publicKey = res.publicKey;
      hasDeployKey = true;
      onUpdate();
    } catch (err: any) {
      alert(`Key generation failed: ${err.message}`);
    } finally {
      isGeneratingKey = false;
    }
  }

  async function deleteDeployKey() {
    if (!confirm('Are you sure you want to delete this deploy key? Private Git cloning will fail unless a new key is added.')) return;
    try {
      await api(`/api/services/${service.id}/deploy-key`, { method: 'DELETE' });
      publicKey = '';
      hasDeployKey = false;
      onUpdate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function toggleWebhook() {
    try {
      const newEnabled = !webhookEnabled;
      await api(`/api/services/${service.id}/webhook`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: newEnabled }),
      });
      webhookEnabled = newEnabled;
      onUpdate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function regenerateSecret() {
    if (!confirm('Regenerating secret will invalidate the current webhook secret in GitHub/GitLab. Continue?')) return;
    isRegeneratingSecret = true;
    try {
      const res = await api(`/api/services/${service.id}/webhook/regenerate-secret`, { method: 'POST' });
      webhookSecret = res.webhookSecret;
      onUpdate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      isRegeneratingSecret = false;
    }
  }

  async function testWebhook() {
    isTestingWebhook = true;
    webhookMessage = '';
    try {
      const res = await api(`/api/services/${service.id}/webhook/test`, { method: 'POST' });
      webhookMessage = 'Test webhook deployment triggered! Check the Deployments tab to watch the build.';
      webhookMessageType = 'success';
      onUpdate();
    } catch (err: any) {
      webhookMessage = `Webhook test failed: ${err.message}`;
      webhookMessageType = 'error';
    } finally {
      isTestingWebhook = false;
    }
  }

  function copyText(text: string, type: 'key' | 'url' | 'secret') {
    navigator.clipboard.writeText(text);
    if (type === 'key') {
      keyCopied = true;
      setTimeout(() => (keyCopied = false), 2000);
    } else if (type === 'url') {
      urlCopied = true;
      setTimeout(() => (urlCopied = false), 2000);
    } else if (type === 'secret') {
      secretCopied = true;
      setTimeout(() => (secretCopied = false), 2000);
    }
  }

  onMount(() => {
    loadData();
  });
</script>

<div class="git-settings-wrap">
  <!-- Top Section: Repo Settings & Deploy Key -->
  <div class="settings-grid">
    <!-- Card 1: Git Repository Config -->
    <div class="card panel-card">
      <div class="panel-header">
        <div class="panel-title">
          <GitBranch class="p-icon" size={20} />
          <h3>Git Repository Configuration</h3>
        </div>
      </div>

      {#if repoMessage}
        <div class="alert {repoMessageType}">
          {#if repoMessageType === 'success'}
            <CheckCircle2 size={16} />
          {:else}
            <AlertCircle size={16} />
          {/if}
          <span>{repoMessage}</span>
        </div>
      {/if}

      <form on:submit|preventDefault={saveRepoSettings} class="form-body">
        <div class="form-group">
          <label for="gitUrl">Repository URL (HTTPS or SSH)</label>
          <input 
            id="gitUrl" 
            type="text" 
            bind:value={gitUrl} 
            placeholder="git@github.com:username/repository.git" 
          />
          <span class="field-hint">Supports SSH format (e.g. <code>git@github.com:...</code>) or public HTTPS.</span>
        </div>

        <div class="row-2">
          <div class="form-group">
            <label for="gitBranch">Branch</label>
            <input id="gitBranch" type="text" bind:value={gitBranch} placeholder="main" required />
          </div>

          <div class="form-group">
            {#if service.type === 'compose'}
              <label for="composePath">Compose File Path</label>
              <input id="composePath" type="text" bind:value={composePath} placeholder="docker-compose.yml" />
            {:else}
              <label for="dockerfilePath">Dockerfile Path</label>
              <input id="dockerfilePath" type="text" bind:value={dockerfilePath} placeholder="Dockerfile" />
            {/if}
          </div>
        </div>

        <div class="actions-row">
          <button type="submit" class="btn btn-primary" disabled={isSavingRepo}>
            {#if isSavingRepo}
              <RefreshCw class="spin" size={16} />
              Saving...
            {:else}
              Save Configuration
            {/if}
          </button>
        </div>
      </form>
    </div>

    <!-- Card 2: SSH Deploy Key -->
    <div class="card panel-card">
      <div class="panel-header">
        <div class="panel-title">
          <Key class="p-icon" size={20} />
          <h3>SSH Deploy Key (Private Repos)</h3>
        </div>
        <span class="status-badge {hasDeployKey ? 'active' : 'inactive'}">
          {hasDeployKey ? 'Key Active' : 'Not Configured'}
        </span>
      </div>

      <p class="panel-desc">
        Add this public key to your repository's <strong>Deploy Keys</strong> with read-only access to allow Dilly to clone private code.
      </p>

      {#if hasDeployKey && publicKey}
        <div class="key-box">
          <div class="key-header">
            <span class="key-type">ED25519 Public Key</span>
            <button class="btn btn-sm btn-outline" on:click={() => copyText(publicKey, 'key')}>
              {#if keyCopied}
                <Check size={14} /> Copied!
              {:else}
                <Copy size={14} /> Copy Key
              {/if}
            </button>
          </div>
          <pre class="key-content">{publicKey}</pre>
        </div>

        <div class="key-actions">
          <button class="btn btn-sm btn-outline" on:click={generateDeployKey} disabled={isGeneratingKey}>
            <RefreshCw size={14} class={isGeneratingKey ? 'spin' : ''} />
            Regenerate Key
          </button>
          <button class="btn btn-sm btn-danger-outline" on:click={deleteDeployKey}>
            <Trash2 size={14} />
            Delete Key
          </button>
        </div>
      {:else}
        <div class="no-key-state">
          <Shield size={36} class="shield-icon" />
          <p>No SSH deploy key configured for this service.</p>
          <button class="btn btn-primary" on:click={generateDeployKey} disabled={isGeneratingKey}>
            {#if isGeneratingKey}
              <RefreshCw class="spin" size={16} /> Generating...
            {:else}
              <Key size={16} /> Generate Ed25519 Deploy Key
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Bottom Section: Push-to-Deploy Webhook -->
  <div class="card panel-card webhook-panel">
    <div class="panel-header">
      <div class="panel-title">
        <Webhook class="p-icon" size={20} />
        <div>
          <h3>Push-to-Deploy Webhook</h3>
          <p class="panel-desc">Automatically rebuild and deploy this service when you push to branch <code>{service.gitBranch || 'main'}</code>.</p>
        </div>
      </div>

      <div class="header-controls">
        <button 
          class="toggle-btn {webhookEnabled ? 'enabled' : 'disabled'}" 
          on:click={toggleWebhook}
        >
          {webhookEnabled ? 'Active' : 'Disabled'}
        </button>
      </div>
    </div>

    {#if webhookMessage}
      <div class="alert {webhookMessageType}">
        {#if webhookMessageType === 'success'}
          <CheckCircle2 size={16} />
        {:else}
          <AlertCircle size={16} />
        {/if}
        <span>{webhookMessage}</span>
      </div>
    {/if}

    <div class="webhook-details">
      <!-- Webhook URL -->
      <div class="form-group">
        <label for="webhookUrl">Webhook URL</label>
        <div class="input-with-button">
          <input id="webhookUrl" type="text" readonly value={webhookUrl} />
          <button class="btn btn-outline" on:click={() => copyText(webhookUrl, 'url')}>
            {#if urlCopied}
              <Check size={16} /> Copied
            {:else}
              <Copy size={16} /> Copy URL
            {/if}
          </button>
        </div>
      </div>

      <!-- Webhook Secret -->
      <div class="form-group">
        <label for="webhookSecret">Webhook Secret (HMAC Token)</label>
        <div class="input-with-button">
          <input 
            id="webhookSecret" 
            type={showSecret ? 'text' : 'password'} 
            readonly 
            value={webhookSecret} 
          />
          <button class="btn btn-icon btn-outline" on:click={() => (showSecret = !showSecret)} title="Toggle view">
            {#if showSecret}
              <EyeOff size={16} />
            {:else}
              <Eye size={16} />
            {/if}
          </button>
          <button class="btn btn-outline" on:click={() => copyText(webhookSecret, 'secret')}>
            {#if secretCopied}
              <Check size={16} /> Copied
            {:else}
              <Copy size={16} /> Copy Secret
            {/if}
          </button>
          <button class="btn btn-outline" on:click={regenerateSecret} disabled={isRegeneratingSecret} title="Generate new secret">
            <RefreshCw size={16} class={isRegeneratingSecret ? 'spin' : ''} />
          </button>
        </div>
        <span class="field-hint">Used to verify that webhook calls originate genuinely from GitHub or GitLab.</span>
      </div>

      <!-- Actions -->
      <div class="webhook-actions">
        <button class="btn btn-success" on:click={testWebhook} disabled={isTestingWebhook}>
          {#if isTestingWebhook}
            <RefreshCw class="spin" size={16} /> Triggering...
          {:else}
            <Play size={16} /> Test Webhook (Simulate Push)
          {/if}
        </button>
      </div>
    </div>

    <!-- Integration Guides -->
    <div class="guide-box">
      <div class="guide-tabs">
        <button 
          class="g-tab {guideTab === 'github' ? 'active' : ''}" 
          on:click={() => (guideTab = 'github')}
        >
          GitHub Setup Guide
        </button>
        <button 
          class="g-tab {guideTab === 'gitlab' ? 'active' : ''}" 
          on:click={() => (guideTab = 'gitlab')}
        >
          GitLab Setup Guide
        </button>
      </div>

      <div class="guide-content">
        {#if guideTab === 'github'}
          <ol class="steps-list">
            <li>Open your GitHub repository and go to <strong>Settings</strong> &gt; <strong>Webhooks</strong> &gt; <strong>Add webhook</strong>.</li>
            <li>Paste <strong>Payload URL</strong>: <code>{webhookUrl}</code></li>
            <li>Set <strong>Content type</strong> to <code>application/json</code>.</li>
            <li>Paste the <strong>Secret</strong> from above into the Secret input.</li>
            <li>Under <em>Which events would you like to trigger this webhook?</em>, select <strong>Just the push event</strong>.</li>
            <li>Ensure <strong>Active</strong> is checked, then click <strong>Add webhook</strong>.</li>
          </ol>
        {:else}
          <ol class="steps-list">
            <li>Open your GitLab repository and navigate to <strong>Settings</strong> &gt; <strong>Webhooks</strong>.</li>
            <li>Paste <strong>URL</strong>: <code>{webhookUrl}</code></li>
            <li>Paste the <strong>Secret token</strong> from above.</li>
            <li>Under <strong>Trigger</strong>, ensure <strong>Push events</strong> is checked (Target branch: <code>{service.gitBranch || 'main'}</code>).</li>
            <li>Click <strong>Add webhook</strong>.</li>
          </ol>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .git-settings-wrap {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    margin-top: 0.5rem;
  }

  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  @media (max-width: 900px) {
    .settings-grid {
      grid-template-columns: 1fr;
    }
  }

  .panel-card {
    background: #181920;
    border: 2px solid #282a36;
    border-radius: 8px;
    padding: 1.25rem;
    box-shadow: 4px 4px 0px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
    border-bottom: 1px solid #282a36;
    padding-bottom: 0.75rem;
  }

  .panel-title {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .panel-title h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
    color: #f8f8f2;
  }

  .p-icon {
    color: #64ffda;
  }

  .panel-desc {
    font-size: 0.85rem;
    color: #a0a0b0;
    margin-top: 0.25rem;
    margin-bottom: 0.75rem;
    line-height: 1.4;
  }

  .panel-desc code {
    background: #0f1015;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    color: #64ffda;
    font-size: 0.82rem;
  }

  .status-badge {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.2rem 0.6rem;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .status-badge.active {
    background: rgba(46, 213, 115, 0.2);
    border: 1px solid #2ed573;
    color: #2ed573;
  }

  .status-badge.inactive {
    background: rgba(255, 71, 87, 0.15);
    border: 1px solid #ff4757;
    color: #ff4757;
  }

  .form-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1;
  }

  .row-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-group label {
    font-size: 0.82rem;
    font-weight: 600;
    color: #ccc;
  }

  .form-group input {
    background: #0d0e12;
    border: 2px solid #282a36;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    color: #fff;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .form-group input:focus {
    border-color: #64ffda;
  }

  .field-hint {
    font-size: 0.75rem;
    color: #888;
  }

  .field-hint code {
    background: #111;
    color: #64ffda;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .input-with-button {
    display: flex;
    gap: 0.4rem;
  }

  .input-with-button input {
    flex: 1;
    font-family: monospace;
    font-size: 0.85rem;
    background: #0d0e12;
    border: 2px solid #282a36;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    color: #64ffda;
  }

  .key-box {
    background: #0d0e12;
    border: 2px solid #282a36;
    border-radius: 6px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .key-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .key-type {
    font-size: 0.75rem;
    font-weight: 700;
    color: #ffb86c;
    text-transform: uppercase;
  }

  .key-content {
    margin: 0;
    padding: 0.5rem;
    background: #050608;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.78rem;
    color: #a4e7a4;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 110px;
    overflow-y: auto;
  }

  .key-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: auto;
  }

  .no-key-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    text-align: center;
    gap: 0.75rem;
    color: #888;
    flex: 1;
  }

  .shield-icon {
    color: #555;
  }

  /* Webhook Panel */
  .webhook-panel {
    gap: 1rem;
  }

  .toggle-btn {
    padding: 0.35rem 0.85rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    border: 2px solid transparent;
    transition: all 0.2s ease;
  }

  .toggle-btn.enabled {
    background: #2ed573;
    color: #000;
    border-color: #2ed573;
    box-shadow: 2px 2px 0px #000;
  }

  .toggle-btn.disabled {
    background: #282a36;
    color: #888;
    border-color: #444;
  }

  .webhook-details {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .webhook-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }

  /* Guide Box */
  .guide-box {
    margin-top: 0.75rem;
    background: #121318;
    border: 1px solid #282a36;
    border-radius: 6px;
    overflow: hidden;
  }

  .guide-tabs {
    display: flex;
    background: #181920;
    border-bottom: 1px solid #282a36;
  }

  .g-tab {
    padding: 0.6rem 1rem;
    background: transparent;
    border: none;
    color: #888;
    font-weight: 600;
    font-size: 0.82rem;
    cursor: pointer;
  }

  .g-tab.active {
    color: #64ffda;
    border-bottom: 2px solid #64ffda;
    background: #121318;
  }

  .guide-content {
    padding: 1rem 1.25rem;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #ccc;
  }

  .steps-list {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .steps-list code {
    background: #08090b;
    color: #ff79c6;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.82rem;
    word-break: break-all;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.95rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    border: 2px solid #282a36;
    transition: all 0.15s ease;
  }

  .btn-primary {
    background: #64ffda;
    color: #0d0e12;
    border-color: #64ffda;
    box-shadow: 2px 2px 0px #000;
  }

  .btn-primary:hover:not(:disabled) {
    background: #4ae0bc;
    transform: translate(-1px, -1px);
    box-shadow: 3px 3px 0px #000;
  }

  .btn-success {
    background: #2ed573;
    color: #000;
    border-color: #2ed573;
    box-shadow: 2px 2px 0px #000;
  }

  .btn-success:hover:not(:disabled) {
    background: #26b963;
    transform: translate(-1px, -1px);
    box-shadow: 3px 3px 0px #000;
  }

  .btn-outline {
    background: #1f2029;
    color: #f8f8f2;
    border-color: #3b3e4f;
  }

  .btn-outline:hover:not(:disabled) {
    background: #2a2c38;
    border-color: #64ffda;
  }

  .btn-danger-outline {
    background: #1f2029;
    color: #ff5555;
    border-color: #ff5555;
  }

  .btn-danger-outline:hover:not(:disabled) {
    background: rgba(255, 85, 85, 0.15);
  }

  .btn-sm {
    padding: 0.35rem 0.65rem;
    font-size: 0.78rem;
  }

  .btn-icon {
    padding: 0.55rem;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.85rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }

  .alert.success {
    background: rgba(46, 213, 115, 0.15);
    border: 1px solid #2ed573;
    color: #2ed573;
  }

  .alert.error {
    background: rgba(255, 71, 87, 0.15);
    border: 1px solid #ff4757;
    color: #ff4757;
  }

  :global(.spin) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
</style>

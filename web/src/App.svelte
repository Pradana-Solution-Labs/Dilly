<script lang="ts">
  import { onMount } from 'svelte';
  import { 
    Layers, Server, Box, Globe, Play, Square, RotateCw, 
    Trash2, Plus, Terminal, Key, Shield, User, LogOut, CheckCircle2, 
    AlertCircle, RefreshCw, ExternalLink, FileCode, Activity, GitBranch, Webhook 
  } from 'lucide-svelte';
  import ComposeEditor from './components/ComposeEditor.svelte';
  import LiveLogs from './components/LiveLogs.svelte';
  import TerminalView from './components/Terminal.svelte';
  import GitWebhookSettings from './components/GitWebhookSettings.svelte';

  // State
  let token = localStorage.getItem('dilly_token') || '';
  let currentUser: any = JSON.parse(localStorage.getItem('dilly_user') || 'null');
  
  let authMode: 'login' | 'register' = 'login';
  let authEmail = '';
  let authPassword = '';
  let authName = '';
  let authError = '';

  let health: any = { docker: 'checking', caddy: 'checking' };
  let activeTab: 'projects' | 'team' | 'proxy' = 'projects';

  let projects: any[] = [];
  let selectedProject: any = null;
  let selectedService: any = null;
  let serviceTab: 'overview' | 'config' | 'git' | 'env' | 'logs' | 'terminal' | 'deployments' = 'overview';

  let newProjectName = '';
  let newProjectDesc = '';
  let showNewProjectModal = false;

  let newServiceName = '';
  let newServiceType: 'dockerfile' | 'compose' = 'compose';
  let newServiceDomain = '';
  let newServicePort = 80;
  let newServiceCompose = '';
  let showNewServiceModal = false;

  let envVarsList: Array<{ key: string; value: string; isSecret: boolean }> = [];
  let deploymentsList: any[] = [];
  let activeLogs = '';
  let showLogsModal = false;

  let usersList: any[] = [];

  // API Client Helper
  async function api(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as any),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  // Auth
  async function handleAuth() {
    authError = '';
    try {
      if (authMode === 'register') {
        const data = await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email: authEmail, password: authPassword, name: authName }),
        });
        token = data.token;
        currentUser = data.user;
      } else {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: authEmail, password: authPassword }),
        });
        token = data.token;
        currentUser = data.user;
      }
      localStorage.setItem('dilly_token', token);
      localStorage.setItem('dilly_user', JSON.stringify(currentUser));
      initDashboard();
    } catch (err: any) {
      authError = err.message;
    }
  }

  function logout() {
    token = '';
    currentUser = null;
    localStorage.removeItem('dilly_token');
    localStorage.removeItem('dilly_user');
  }

  // Health
  async function checkHealth() {
    try {
      const res = await api('/health');
      health = res.services;
    } catch {
      health = { docker: 'disconnected', caddy: 'disconnected' };
    }
  }

  // Projects & Services
  async function loadProjects() {
    try {
      projects = await api('/api/projects');
      if (projects.length > 0 && !selectedProject) {
        selectProject(projects[0]);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function createProject() {
    if (!newProjectName) return;
    try {
      const p = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: newProjectName, description: newProjectDesc }),
      });
      newProjectName = '';
      newProjectDesc = '';
      showNewProjectModal = false;
      await loadProjects();
      selectProject(p);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function selectProject(p: any) {
    selectedProject = p;
    selectedService = null;
    try {
      const data = await api(`/api/projects/${p.id}`);
      selectedProject = data;
    } catch (err) {
      console.error(err);
    }
  }

  async function createService() {
    if (!newServiceName || !selectedProject) return;
    try {
      await api(`/api/services/project/${selectedProject.id}`, {
        method: 'POST',
        body: JSON.stringify({
          name: newServiceName,
          type: newServiceType,
          domain: newServiceDomain || undefined,
          internalPort: Number(newServicePort) || 80,
          composeContent: newServiceType === 'compose' && newServiceCompose.trim() ? newServiceCompose : undefined,
        }),
      });
      newServiceName = '';
      newServiceDomain = '';
      newServiceCompose = '';
      showNewServiceModal = false;
      await selectProject(selectedProject);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleSaveCompose(newContent: string) {
    if (!selectedService) return;
    const updated = await api(`/api/services/${selectedService.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ composeContent: newContent }),
    });
    selectedService = { ...selectedService, composeContent: updated.composeContent };
  }

  function handleEnvDetected(data: any) {
    if (data.variables) {
      envVarsList = data.variables.map((e: any) => ({
        key: e.key,
        value: e.value,
        isSecret: e.isSecret,
      }));
    }
  }

  async function selectService(s: any) {
    try {
      const data = await api(`/api/services/${s.id}`);
      selectedService = data;
      envVarsList = (data.envVars || []).map((e: any) => ({
        key: e.key,
        value: e.value,
        isSecret: e.isSecret,
      }));
      await loadDeployments(s.id);
    } catch (err) {
      console.error(err);
    }
  }

  // Environment Variables
  function addEnvRow() {
    envVarsList = [...envVarsList, { key: '', value: '', isSecret: false }];
  }

  function removeEnvRow(idx: number) {
    envVarsList = envVarsList.filter((_, i) => i !== idx);
  }

  async function saveEnvVars() {
    if (!selectedService) return;
    try {
      await api(`/api/services/${selectedService.id}/env`, {
        method: 'POST',
        body: JSON.stringify({
          variables: envVarsList.filter((v) => v.key.trim() !== ''),
        }),
      });
      alert('Environment variables saved successfully');
      await selectService(selectedService);
    } catch (err: any) {
      alert(err.message);
    }
  }

  // Deploy Actions
  async function triggerDeploy() {
    if (!selectedService) return;
    try {
      await api(`/api/services/${selectedService.id}/deploy`, { method: 'POST' });
      selectedService.status = 'deploying';
      await loadDeployments(selectedService.id);
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function triggerRestart() {
    if (!selectedService) return;
    try {
      await api(`/api/services/${selectedService.id}/restart`, { method: 'POST' });
      selectedService.status = 'running';
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function triggerStop() {
    if (!selectedService) return;
    try {
      await api(`/api/services/${selectedService.id}/stop`, { method: 'POST' });
      selectedService.status = 'stopped';
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function loadDeployments(serviceId: string) {
    try {
      deploymentsList = await api(`/api/services/${serviceId}/deployments`);
    } catch (err) {
      console.error(err);
    }
  }

  function viewLogs(logs: string) {
    activeLogs = logs || 'No output logs recorded.';
    showLogsModal = true;
  }

  // Team
  async function loadUsers() {
    try {
      usersList = await api('/api/auth/users');
    } catch (err) {
      console.error(err);
    }
  }

  async function updateUserRole(userId: string, role: string) {
    try {
      await api(`/api/auth/users/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      await loadUsers();
    } catch (err: any) {
      alert(err.message);
    }
  }

  // Proxy
  async function syncProxy() {
    try {
      const res = await api('/api/proxy/sync', { method: 'POST' });
      alert(`Proxy routes synced: ${res.syncedCount} of ${res.totalConfigured} active`);
    } catch (err: any) {
      alert(err.message);
    }
  }

  function initDashboard() {
    checkHealth();
    loadProjects();
    if (currentUser?.role === 'owner' || currentUser?.role === 'admin') {
      loadUsers();
    }
  }

  onMount(() => {
    if (token) {
      initDashboard();
    }
  });
</script>

<main class="app-container">
  {#if !token}
    <!-- Auth Card -->
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="brand-header">
          <Layers class="icon-brand" />
          <h2>Dilly PaaS</h2>
          <p>Lean self-hosted cloud platform</p>
        </div>

        {#if authError}
          <div class="alert error">
            <AlertCircle size={18} />
            <span>{authError}</span>
          </div>
        {/if}

        <form on:submit|preventDefault={handleAuth}>
          {#if authMode === 'register'}
            <div class="form-group">
              <label for="name">Full Name</label>
              <input id="name" type="text" bind:value={authName} placeholder="Admin User" required />
            </div>
          {/if}
          <div class="form-group">
            <label for="email">Email</label>
            <input id="email" type="email" bind:value={authEmail} placeholder="admin@example.com" required />
          </div>
          <div class="form-group">
            <label for="password">Password</label>
            <input id="password" type="password" bind:value={authPassword} placeholder="••••••••" required />
          </div>

          <button type="submit" class="btn btn-primary full-width">
            {authMode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div class="auth-toggle">
          {#if authMode === 'login'}
            <span>No account yet? </span>
            <button class="link-btn" on:click={() => (authMode = 'register')}>Register here</button>
          {:else}
            <span>Already have an account? </span>
            <button class="link-btn" on:click={() => (authMode = 'login')}>Log in</button>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <!-- Main Dashboard -->
    <div class="layout">
      <!-- Top Navbar -->
      <header class="navbar">
        <div class="nav-left">
          <Layers class="icon-brand" size={24} />
          <span class="logo-text">Dilly</span>
          <div class="health-badges">
            <span class="badge {health.docker === 'connected' ? 'ok' : 'err'}">
              Docker: {health.docker}
            </span>
            <span class="badge {health.caddy === 'connected' ? 'ok' : 'err'}">
              Caddy: {health.caddy}
            </span>
          </div>
        </div>

        <div class="nav-right">
          <div class="user-pill">
            <User size={16} />
            <span>{currentUser?.name}</span>
            <span class="role-tag">{currentUser?.role}</span>
          </div>
          <button class="icon-btn" on:click={logout} title="Sign Out">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <!-- Sub Navigation -->
      <nav class="sub-nav">
        <button class="tab-btn {activeTab === 'projects' ? 'active' : ''}" on:click={() => (activeTab = 'projects')}>
          <Box size={16} /> Projects
        </button>
        {#if currentUser?.role === 'owner' || currentUser?.role === 'admin'}
          <button class="tab-btn {activeTab === 'team' ? 'active' : ''}" on:click={() => (activeTab = 'team')}>
            <Shield size={16} /> Team & RBAC
          </button>
          <button class="tab-btn {activeTab === 'proxy' ? 'active' : ''}" on:click={() => (activeTab = 'proxy')}>
            <Globe size={16} /> Proxy & SSL
          </button>
        {/if}
      </nav>

      <!-- Tab Content -->
      <section class="content-area">
        {#if activeTab === 'projects'}
          <div class="project-layout">
            <!-- Sidebar: Projects list -->
            <aside class="sidebar">
              <div class="sidebar-header">
                <h3>Projects</h3>
                {#if currentUser?.role === 'owner' || currentUser?.role === 'admin'}
                  <button class="btn btn-sm btn-primary" on:click={() => (showNewProjectModal = true)}>
                    <Plus size={14} /> New
                  </button>
                {/if}
              </div>
              <ul class="project-list">
                {#each projects as p}
                  <li 
                    class="project-item {selectedProject?.id === p.id ? 'active' : ''}" 
                    on:click={() => selectProject(p)}
                  >
                    <span class="p-name">{p.name}</span>
                    <span class="p-desc">{p.description || 'No description'}</span>
                  </li>
                {/each}
              </ul>
            </aside>

            <!-- Main: Project details & Services -->
            <div class="project-main">
              {#if selectedProject}
                <div class="project-banner">
                  <div>
                    <h2>{selectedProject.name}</h2>
                    <p class="text-muted">{selectedProject.description || 'Internal Infrastructure Project'}</p>
                  </div>
                  {#if currentUser?.role === 'owner' || currentUser?.role === 'admin'}
                    <button class="btn btn-primary" on:click={() => (showNewServiceModal = true)}>
                      <Plus size={16} /> Add Service
                    </button>
                  {/if}
                </div>

                <!-- Services Grid -->
                <div class="services-grid">
                  {#each selectedProject.services || [] as s}
                    <div 
                      class="service-card {selectedService?.id === s.id ? 'selected' : ''}" 
                      on:click={() => selectService(s)}
                    >
                      <div class="sc-header">
                        <div class="sc-title">
                          <Server size={18} />
                          <strong>{s.name}</strong>
                        </div>
                        <span class="status-indicator {s.status}">
                          {s.status}
                        </span>
                      </div>

                      <div class="sc-meta">
                        <span class="type-badge">{s.type}</span>
                        {#if s.domain}
                          <a href={`http://${s.domain}`} target="_blank" class="domain-link" on:click|stopPropagation>
                            {s.domain} <ExternalLink size={12} />
                          </a>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>

                <!-- Service Workspace -->
                {#if selectedService}
                  <div class="service-detail card">
                    <div class="sd-header">
                      <div>
                        <h3>{selectedService.name}</h3>
                        <span class="text-muted">Type: {selectedService.type} | Port: {selectedService.internalPort}</span>
                      </div>
                      
                      <div class="sd-actions">
                        {#if currentUser?.role !== 'viewer'}
                          <button class="btn btn-primary" on:click={triggerDeploy}>
                            <Play size={16} /> Deploy
                          </button>
                          <button class="btn btn-secondary" on:click={triggerRestart}>
                            <RotateCw size={16} /> Restart
                          </button>
                          <button class="btn btn-danger" on:click={triggerStop}>
                            <Square size={16} /> Stop
                          </button>
                        {/if}
                      </div>
                    </div>

                    <!-- Service Detail Tabs -->
                    <div class="sd-tabs">
                      <button class="tab-sub {serviceTab === 'overview' ? 'active' : ''}" on:click={() => (serviceTab = 'overview')}>
                        Overview
                      </button>
                      <button class="tab-sub {serviceTab === 'config' ? 'active' : ''}" on:click={() => (serviceTab = 'config')}>
                        Compose / Config
                      </button>
                      <button class="tab-sub {serviceTab === 'git' ? 'active' : ''}" on:click={() => (serviceTab = 'git')}>
                        Git & Webhooks
                      </button>
                      <button class="tab-sub {serviceTab === 'env' ? 'active' : ''}" on:click={() => (serviceTab = 'env')}>
                        Environment Variables
                      </button>
                      <button class="tab-sub {serviceTab === 'logs' ? 'active' : ''}" on:click={() => (serviceTab = 'logs')}>
                        Live Logs
                      </button>
                      <button class="tab-sub {serviceTab === 'terminal' ? 'active' : ''}" on:click={() => (serviceTab = 'terminal')}>
                        Terminal
                      </button>
                      <button class="tab-sub {serviceTab === 'deployments' ? 'active' : ''}" on:click={() => (serviceTab = 'deployments')}>
                        Deployments
                      </button>
                    </div>

                    <div class="sd-content">
                      {#if serviceTab === 'overview'}
                        <div class="info-grid">
                          <div class="info-item">
                            <label>Domain</label>
                            <span>{selectedService.domain || 'No custom domain set'}</span>
                          </div>
                          <div class="info-item">
                            <label>Internal Port</label>
                            <span>{selectedService.internalPort || 80}</span>
                          </div>
                          <div class="info-item">
                            <label>Git Source</label>
                            <span>{selectedService.gitUrl || 'Local / Docker Hub image'}</span>
                          </div>
                          <div class="info-item">
                            <label>Branch</label>
                            <span>{selectedService.gitBranch || 'main'}</span>
                          </div>
                        </div>
                      {:else if serviceTab === 'config'}
                        <ComposeEditor
                          service={selectedService}
                          {token}
                          onSave={handleSaveCompose}
                          onEnvDetected={handleEnvDetected}
                        />
                      {:else if serviceTab === 'git'}
                        <GitWebhookSettings
                          service={selectedService}
                          {token}
                          onUpdate={() => selectService(selectedService)}
                        />
                      {:else if serviceTab === 'logs'}
                        <LiveLogs service={selectedService} {token} />
                      {:else if serviceTab === 'terminal'}
                        <TerminalView service={selectedService} {token} />
                      {:else if serviceTab === 'env'}
                        <div class="env-section">
                          <div class="env-table">
                            {#each envVarsList as ev, i}
                              <div class="env-row">
                                <input type="text" placeholder="KEY" bind:value={ev.key} />
                                <input type="text" placeholder="VALUE" bind:value={ev.value} />
                                <label class="secret-toggle">
                                  <input type="checkbox" bind:checked={ev.isSecret} />
                                  <span>Secret</span>
                                </label>
                                <button class="icon-btn-danger" on:click={() => removeEnvRow(i)}>
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            {/each}
                          </div>

                          <div class="env-actions">
                            <button class="btn btn-secondary" on:click={addEnvRow}>
                              <Plus size={14} /> Add Row
                            </button>
                            <button class="btn btn-primary" on:click={saveEnvVars}>
                              Save Variables
                            </button>
                          </div>
                        </div>
                      {:else if serviceTab === 'deployments'}
                        <div class="deploy-history">
                          {#if deploymentsList.length === 0}
                            <div class="empty-deployments">
                              <p>No deployments recorded yet for this service.</p>
                            </div>
                          {/if}
                          {#each deploymentsList as d}
                            <div class="deploy-row">
                              <div class="d-meta">
                                <span class="status-indicator {d.status}">{d.status}</span>
                                <span class="trigger-badge {d.triggeredBy || 'manual'}">{d.triggeredBy || 'manual'}</span>
                                {#if d.commitHash}
                                  <span class="commit-pill" title={d.commitMessage || ''}>
                                    <code>{d.commitHash.substring(0, 7)}</code>
                                    {#if d.commitMessage}
                                      <span class="commit-msg">{d.commitMessage.split('\n')[0]}</span>
                                    {/if}
                                  </span>
                                {/if}
                                <span class="deploy-time">{new Date(d.startedAt).toLocaleString()}</span>
                              </div>
                              <button class="btn btn-sm btn-secondary" on:click={() => viewLogs(d.logs)}>
                                <Terminal size={14} /> View Logs
                              </button>
                            </div>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  </div>
                {/if}
              {:else}
                <div class="empty-state">
                  <Box size={48} />
                  <p>Select or create a project to get started</p>
                </div>
              {/if}
            </div>
          </div>
        {:else if activeTab === 'team'}
          <!-- Team / RBAC -->
          <div class="card team-card">
            <div class="card-header">
              <h3>Single-Team RBAC</h3>
              <p class="text-muted">Manage user privileges for your organization</p>
            </div>
            <table class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each usersList as u}
                  <tr>
                    <td><strong>{u.name}</strong></td>
                    <td>{u.email}</td>
                    <td><span class="role-tag">{u.role}</span></td>
                    <td>
                      {#if currentUser?.role === 'owner' && u.id !== currentUser.id}
                        <select 
                          value={u.role} 
                          on:change={(e) => updateUserRole(u.id, (e.target as HTMLSelectElement).value)}
                        >
                          <option value="owner">Owner</option>
                          <option value="admin">Admin</option>
                          <option value="developer">Developer</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      {:else}
                        <span class="text-muted">Locked</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else if activeTab === 'proxy'}
          <!-- Proxy / Caddy -->
          <div class="card proxy-card">
            <div class="card-header">
              <h3>Caddy Reverse Proxy & SSL</h3>
              <p class="text-muted">Dynamic routing and automatic Let's Encrypt certificates</p>
            </div>
            <div class="proxy-status-box">
              <div class="ps-item">
                <span>Caddy API Status</span>
                <strong class={health.caddy === 'connected' ? 'text-ok' : 'text-err'}>
                  {health.caddy}
                </strong>
              </div>
              <button class="btn btn-primary" on:click={syncProxy}>
                <RefreshCw size={16} /> Sync All Routes
              </button>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}

  <!-- Modal: New Project -->
  {#if showNewProjectModal}
    <div class="modal-backdrop" on:click={() => (showNewProjectModal = false)}>
      <div class="modal card" on:click|stopPropagation>
        <h3>Create Project</h3>
        <div class="form-group">
          <label>Project Name</label>
          <input type="text" bind:value={newProjectName} placeholder="api-cluster" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <input type="text" bind:value={newProjectDesc} placeholder="Internal billing services" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" on:click={() => (showNewProjectModal = false)}>Cancel</button>
          <button class="btn btn-primary" on:click={createProject}>Create</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Modal: New Service -->
  {#if showNewServiceModal}
    <div class="modal-backdrop" on:click={() => (showNewServiceModal = false)}>
      <div class="modal card" on:click|stopPropagation>
        <h3>Add Service</h3>
        <div class="form-group">
          <label>Service Name</label>
          <input type="text" bind:value={newServiceName} placeholder="web-gateway" />
        </div>
        <div class="form-group">
          <label>Service Type</label>
          <select bind:value={newServiceType}>
            <option value="compose">Docker Compose (Recommended)</option>
            <option value="dockerfile">Dockerfile</option>
          </select>
        </div>
        <div class="form-group">
          <label>Custom Domain</label>
          <input type="text" bind:value={newServiceDomain} placeholder="app.internal.dev" />
        </div>
        <div class="form-group">
          <label>Internal Port</label>
          <input type="number" bind:value={newServicePort} placeholder="80" />
        </div>
        {#if newServiceType === 'compose'}
          <div class="form-group">
            <label>docker-compose.yml (Optional, auto-extracts env variables)</label>
            <textarea
              bind:value={newServiceCompose}
              rows="4"
              class="code-input"
              placeholder="version: '3.8'&#10;services:&#10;  app:&#10;    image: my-app&#10;    environment:&#10;      - PORT=80"
            ></textarea>
          </div>
        {/if}
        <div class="modal-actions">
          <button class="btn btn-secondary" on:click={() => (showNewServiceModal = false)}>Cancel</button>
          <button class="btn btn-primary" on:click={createService}>Add Service</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Modal: Logs -->
  {#if showLogsModal}
    <div class="modal-backdrop" on:click={() => (showLogsModal = false)}>
      <div class="modal card modal-lg" on:click|stopPropagation>
        <div class="modal-header">
          <h3>Deployment Logs</h3>
          <button class="icon-btn" on:click={() => (showLogsModal = false)}>✕</button>
        </div>
        <pre class="logs-viewer">{activeLogs}</pre>
      </div>
    </div>
  {/if}
</main>

<style>
  :global(:root) {
    --bg-base: #0f172a;
    --bg-surface: #1e293b;
    --bg-surface-hover: #334155;
    --border: #334155;
    --text: #f8fafc;
    --text-muted: #94a3b8;
    --primary: #3b82f6;
    --primary-hover: #2563eb;
    --success: #10b981;
    --danger: #ef4444;
    --warning: #f59e0b;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    background-color: var(--bg-base);
    color: var(--text);
  }

  .app-container {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .auth-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .card {
    background-color: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 24px;
  }

  .auth-card {
    width: 100%;
    max-width: 400px;
  }

  .brand-header {
    text-align: center;
    margin-bottom: 24px;
  }

  :global(.icon-brand) {
    color: var(--primary);
  }

  .navbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    background-color: var(--bg-surface);
  }

  .nav-left, .nav-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .logo-text {
    font-weight: 700;
    font-size: 1.25rem;
    letter-spacing: -0.5px;
  }

  .health-badges {
    display: flex;
    gap: 8px;
    margin-left: 12px;
  }

  .badge {
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 9999px;
  }

  .badge.ok { background: rgba(16, 185, 129, 0.2); color: var(--success); }
  .badge.err { background: rgba(239, 68, 68, 0.2); color: var(--danger); }

  .user-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 20px;
    font-size: 0.875rem;
  }

  .role-tag {
    background: var(--primary);
    color: #fff;
    font-size: 0.7rem;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
  }

  .sub-nav {
    display: flex;
    gap: 8px;
    padding: 8px 24px;
    border-bottom: 1px solid var(--border);
    background: #151f30;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 8px 16px;
    cursor: pointer;
    border-radius: 6px;
  }

  .tab-btn.active {
    background: var(--bg-surface);
    color: var(--text);
  }

  .content-area {
    padding: 24px;
    flex: 1;
  }

  .project-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 24px;
  }

  .sidebar {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    height: fit-content;
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .project-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .project-item {
    padding: 12px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .project-item:hover {
    background: var(--bg-surface-hover);
  }

  .project-item.active {
    background: var(--bg-surface-hover);
    border-color: var(--primary);
  }

  .p-name { display: block; font-weight: 600; }
  .p-desc { display: block; font-size: 0.75rem; color: var(--text-muted); }

  .project-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }

  .services-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .service-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
  }

  .service-card.selected {
    border-color: var(--primary);
  }

  .sc-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }

  .sc-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-indicator {
    font-size: 0.75rem;
    padding: 2px 6px;
    border-radius: 4px;
    text-transform: capitalize;
  }

  .status-indicator.running { background: rgba(16, 185, 129, 0.2); color: var(--success); }
  .status-indicator.deploying { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
  .status-indicator.failed { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
  .status-indicator.stopped { background: rgba(148, 163, 184, 0.2); color: var(--text-muted); }

  .sc-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .type-badge {
    font-size: 0.7rem;
    padding: 2px 6px;
    background: #0f172a;
    border-radius: 4px;
  }

  .domain-link {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--primary);
    text-decoration: none;
    font-size: 0.75rem;
  }

  .service-detail {
    margin-top: 24px;
  }

  .sd-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .sd-actions {
    display: flex;
    gap: 8px;
  }

  .sd-tabs {
    display: flex;
    gap: 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
  }

  .tab-sub {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 8px 4px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .tab-sub.active {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }

  .info-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }

  .info-item label {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 4px;
  }

  .env-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .env-row {
    display: grid;
    grid-template-columns: 1fr 2fr auto auto;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }

  .secret-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
  }

  .env-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .deploy-history {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .deploy-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: #0f172a;
    border-radius: 6px;
  }

  .d-meta {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .trigger-badge {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .trigger-badge.manual {
    background: rgba(100, 255, 218, 0.15);
    border: 1px solid #64ffda;
    color: #64ffda;
  }

  .trigger-badge.webhook {
    background: rgba(255, 121, 198, 0.15);
    border: 1px solid #ff79c6;
    color: #ff79c6;
  }

  .commit-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: #181920;
    border: 1px solid #282a36;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.78rem;
  }

  .commit-pill code {
    color: #f1fa8c;
    font-family: monospace;
    font-weight: bold;
  }

  .commit-msg {
    color: #bbb;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .deploy-time {
    font-size: 0.8rem;
    color: #888;
  }

  .empty-deployments {
    padding: 1.5rem;
    text-align: center;
    color: #888;
    background: #0d0e12;
    border-radius: 6px;
    border: 1px dashed #282a36;
  }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .btn-sm { padding: 4px 10px; font-size: 0.75rem; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover { background: var(--primary-hover); }
  .btn-secondary { background: var(--bg-surface-hover); color: var(--text); }
  .btn-danger { background: var(--danger); color: #fff; }

  .icon-btn, .icon-btn-danger {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
  }
  .icon-btn-danger:hover { color: var(--danger); }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    font-size: 0.875rem;
    margin-bottom: 6px;
    color: var(--text-muted);
  }

  input, select {
    width: 100%;
    padding: 8px 12px;
    background: #0f172a;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    box-sizing: border-box;
  }

  .full-width { width: 100%; }
  .text-muted { color: var(--text-muted); font-size: 0.875rem; }
  .text-ok { color: var(--success); }
  .text-err { color: var(--danger); }

  .modal-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
  }

  .modal { width: 100%; max-width: 480px; }
  .modal-lg { max-width: 800px; }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .logs-viewer {
    background: #000;
    color: #10b981;
    padding: 16px;
    border-radius: 6px;
    font-family: monospace;
    font-size: 0.8rem;
    max-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
  }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 16px;
  }

  .data-table th, .data-table td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .proxy-status-box {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    background: #0f172a;
    border-radius: 6px;
    margin-top: 16px;
  }

  .code-input {
    width: 100%;
    background: #0d0e12;
    color: #64ffda;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 8px;
    font-family: monospace;
    font-size: 0.8rem;
    resize: vertical;
    box-sizing: border-box;
  }
</style>

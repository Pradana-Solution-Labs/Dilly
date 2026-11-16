<script lang="ts">
  import { Save, Sparkles, FileCode, CheckCircle2, AlertCircle } from 'lucide-svelte';

  export let service: any;
  export let token: string;
  export let onSave: (newContent: string) => Promise<void>;
  export let onEnvDetected: (result: any) => void;

  let content = service?.composeContent || '';
  let isSaving = false;
  let isDetecting = false;
  let message = '';
  let messageType: 'success' | 'error' = 'success';

  // Watch for service changes
  $: if (service) {
    content = service.composeContent || '';
  }

  const templates: Record<string, string> = {
    whoami: `version: '3.8'
services:
  whoami:
    image: traefik/whoami
    ports:
      - "\${PORT:-8080}:80"
    environment:
      - APP_NAME=\${APP_NAME:-dilly-app}
`,
    wordpress: `version: '3.8'
services:
  web:
    image: wordpress:latest
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:80"
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_USER: \${MYSQL_USER:-root}
      WORDPRESS_DB_PASSWORD: \${MYSQL_PASSWORD}
      WORDPRESS_DB_NAME: wordpress
    depends_on:
      - db

  db:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_DATABASE: wordpress
    volumes:
      - db_data:/var/lib/mysql

volumes:
  db_data:
`,
    node_redis: `version: '3.8'
services:
  api:
    image: node:20-alpine
    command: npm start
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      NODE_ENV: \${NODE_ENV:-production}
      REDIS_HOST: redis
      API_SECRET_KEY: \${API_SECRET}
    depends_on:
      - redis

  redis:
    image: redis:alpine
    restart: unless-stopped
`,
    postgres: `version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: \${POSTGRES_DB:-app_db}
    ports:
      - "\${DB_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
`
  };

  function applyTemplate(key: string) {
    if (templates[key]) {
      if (content.trim() && !confirm('Replace current Compose content with template?')) {
        return;
      }
      content = templates[key];
    }
  }

  async function handleSave() {
    isSaving = true;
    message = '';
    try {
      await onSave(content);
      message = 'Configuration saved successfully!';
      messageType = 'success';
      setTimeout(() => (message = ''), 4000);
    } catch (err: any) {
      message = err.message || 'Failed to save configuration';
      messageType = 'error';
    } finally {
      isSaving = false;
    }
  }

  async function handleAutoDetect() {
    isDetecting = true;
    message = '';
    try {
      const res = await fetch(`/api/services/${service.id}/env/auto-detect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ composeContent: content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to auto-detect variables');

      message = `Found ${data.detected} variables: ${data.added} newly added, ${data.skipped} already exist.`;
      messageType = 'success';
      onEnvDetected(data);
      setTimeout(() => (message = ''), 5000);
    } catch (err: any) {
      message = err.message || 'Auto-detection failed';
      messageType = 'error';
    } finally {
      isDetecting = false;
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      content = content.substring(0, start) + '  ' + content.substring(end);
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  }
</script>

<div class="compose-editor-wrapper">
  <div class="editor-toolbar">
    <div class="toolbar-left">
      <FileCode size={18} class="text-accent" />
      <span class="file-label">docker-compose.yml</span>
      
      <div class="template-selector">
        <label for="template-select">Template:</label>
        <select id="template-select" on:change={(e) => applyTemplate(e.currentTarget.value)}>
          <option value="">Load Preset...</option>
          <option value="whoami">Traefik Whoami (Lightweight HTTP)</option>
          <option value="wordpress">WordPress + MySQL</option>
          <option value="node_redis">Node.js + Redis</option>
          <option value="postgres">PostgreSQL 16</option>
        </select>
      </div>
    </div>

    <div class="toolbar-actions">
      <button class="btn btn-secondary btn-sm" on:click={handleAutoDetect} disabled={isDetecting || !content.trim()}>
        <Sparkles size={14} />
        {isDetecting ? 'Detecting...' : 'Auto-Detect Variables'}
      </button>

      <button class="btn btn-primary btn-sm" on:click={handleSave} disabled={isSaving}>
        <Save size={14} />
        {isSaving ? 'Saving...' : 'Save Configuration'}
      </button>
    </div>
  </div>

  {#if message}
    <div class="editor-alert {messageType}">
      {#if messageType === 'success'}
        <CheckCircle2 size={16} />
      {:else}
        <AlertCircle size={16} />
      {/if}
      <span>{message}</span>
    </div>
  {/if}

  <div class="editor-container">
    <textarea
      class="code-textarea"
      bind:value={content}
      on:keydown={handleKeyDown}
      placeholder="Paste or write your docker-compose.yml configuration here..."
      spellcheck="false"
    ></textarea>
  </div>

  <div class="editor-footer">
    <span class="tip-text">
      💡 <strong>Tip:</strong> You can use <code>${'{'}MY_VAR:-default_val{'}'}</code> or declare keys in <code>environment:</code>. Click <strong>Auto-Detect Variables</strong> to automatically sync them to your Environment Variables tab.
    </span>
    <span class="line-count">{content.split('\n').length} lines</span>
  </div>
</div>

<style>
  .compose-editor-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    height: 100%;
  }

  .editor-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #18191e;
    padding: 0.5rem 0.75rem;
    border: 2px solid #282a36;
    border-radius: 6px;
    box-shadow: 2px 2px 0px rgba(0,0,0,0.5);
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .file-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: #e0e0e0;
    font-family: monospace;
  }

  .template-selector {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #888;
  }

  .template-selector select {
    background: #111216;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.78rem;
  }

  .toolbar-actions {
    display: flex;
    gap: 0.5rem;
  }

  .editor-alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .editor-alert.success {
    background: rgba(46, 213, 115, 0.15);
    border: 1px solid #2ed573;
    color: #2ed573;
  }

  .editor-alert.error {
    background: rgba(255, 71, 87, 0.15);
    border: 1px solid #ff4757;
    color: #ff4757;
  }

  .editor-container {
    position: relative;
    border: 2px solid #282a36;
    border-radius: 6px;
    background: #0d0e12;
    overflow: hidden;
    box-shadow: inset 0 2px 4px rgba(0,0,0,0.4);
  }

  .code-textarea {
    width: 100%;
    height: 440px;
    background: transparent;
    color: #a4e7a4;
    border: none;
    outline: none;
    resize: vertical;
    font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
    font-size: 0.88rem;
    line-height: 1.5;
    padding: 0.85rem;
    tab-size: 2;
    white-space: pre;
    box-sizing: border-box;
  }

  .editor-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
    color: #777;
    padding: 0 0.25rem;
  }

  .tip-text code {
    background: #222;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    color: #64ffda;
  }

  .line-count {
    font-family: monospace;
    color: #999;
  }
</style>

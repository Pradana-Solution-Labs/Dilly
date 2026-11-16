<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal as TerminalIcon, Search, Trash2, Pause, Play, RefreshCw, Layers } from 'lucide-svelte';

  export let service: any;
  export let token: string;

  let containers: Array<{ id: string; name: string; service: string; state: string }> = [];
  let selectedContainerId = '';
  let logs: string[] = [];
  let ws: WebSocket | null = null;
  let isConnected = false;
  let isPaused = false;
  let autoScroll = true;
  let searchFilter = '';
  let tailLines = '100';
  let logsContainer: HTMLDivElement;

  $: filteredLogs = searchFilter.trim()
    ? logs.filter((line) => line.toLowerCase().includes(searchFilter.toLowerCase()))
    : logs;

  onMount(async () => {
    await fetchContainers();
    connectWebSocket();
  });

  onDestroy(() => {
    disconnectWebSocket();
  });

  $: if (service?.id) {
    fetchContainers().then(() => {
      connectWebSocket();
    });
  }

  async function fetchContainers() {
    try {
      const res = await fetch(`/api/services/${service.id}/containers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        containers = data.containers || [];
        if (containers.length > 0 && !selectedContainerId) {
          selectedContainerId = containers[0].id;
        }
      }
    } catch (e) {
      console.warn('Failed to load containers:', e);
    }
  }

  function connectWebSocket() {
    disconnectWebSocket();
    logs = [];

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let url = `${protocol}//${host}/api/services/${service.id}/logs/ws?token=${encodeURIComponent(token)}&tail=${tailLines}`;
    if (selectedContainerId) {
      url += `&containerId=${selectedContainerId}`;
    }

    try {
      ws = new WebSocket(url);

      ws.onopen = () => {
        isConnected = true;
      };

      ws.onmessage = (event) => {
        if (isPaused) return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'log' || parsed.type === 'system') {
            const raw = parsed.data;
            const lines = raw.split('\n');
            for (const l of lines) {
              if (l) logs.push(l);
            }
            if (logs.length > 2000) {
              logs = logs.slice(logs.length - 2000);
            }
            if (autoScroll && logsContainer) {
              setTimeout(() => {
                logsContainer.scrollTop = logsContainer.scrollHeight;
              }, 10);
            }
          } else if (parsed.type === 'error') {
            logs.push(`[Error] ${parsed.error}`);
          }
        } catch {
          logs.push(event.data);
        }
      };

      ws.onclose = () => {
        isConnected = false;
      };

      ws.onerror = () => {
        isConnected = false;
      };
    } catch (e) {
      console.error('WebSocket connection error:', e);
    }
  }

  function disconnectWebSocket() {
    if (ws) {
      ws.close();
      ws = null;
    }
    isConnected = false;
  }

  function handleContainerChange() {
    connectWebSocket();
  }

  function handleTailChange() {
    connectWebSocket();
  }

  function clearLogs() {
    logs = [];
  }

  function togglePause() {
    isPaused = !isPaused;
  }
</script>

<div class="live-logs-wrapper">
  <!-- Controls bar -->
  <div class="logs-controls">
    <div class="controls-left">
      {#if containers.length > 1}
        <div class="control-group">
          <Layers size={14} class="text-accent" />
          <select bind:value={selectedContainerId} on:change={handleContainerChange} class="select-sm">
            {#each containers as c}
              <option value={c.id}>
                {c.service} ({c.name}) - {c.state}
              </option>
            {/each}
          </select>
        </div>
      {:else if containers.length === 1}
        <span class="container-badge">
          Container: <strong>{containers[0].name}</strong> ({containers[0].state})
        </span>
      {/if}

      <div class="search-box">
        <Search size={13} />
        <input
          type="text"
          placeholder="Filter logs..."
          bind:value={searchFilter}
          class="input-filter"
        />
      </div>
    </div>

    <div class="controls-right">
      <div class="status-pill {isConnected ? 'connected' : 'disconnected'}">
        <span class="status-dot"></span>
        {isConnected ? (isPaused ? 'Paused' : 'Live') : 'Disconnected'}
      </div>

      <select bind:value={tailLines} on:change={handleTailChange} class="select-sm">
        <option value="50">Tail 50</option>
        <option value="100">Tail 100</option>
        <option value="250">Tail 250</option>
        <option value="500">Tail 500</option>
        <option value="all">Tail All</option>
      </select>

      <button class="btn btn-secondary btn-xs" on:click={togglePause} title={isPaused ? 'Resume stream' : 'Pause stream'}>
        {#if isPaused}
          <Play size={12} /> Resume
        {:else}
          <Pause size={12} /> Pause
        {/if}
      </button>

      <button class="btn btn-secondary btn-xs" on:click={connectWebSocket} title="Reconnect">
        <RefreshCw size={12} />
      </button>

      <button class="btn btn-secondary btn-xs" on:click={clearLogs} title="Clear view">
        <Trash2 size={12} />
      </button>
    </div>
  </div>

  <!-- Terminal log display -->
  <div class="logs-viewport" bind:this={logsContainer}>
    {#if filteredLogs.length === 0}
      <div class="empty-logs">
        {#if !isConnected}
          <span>Connecting to container logs...</span>
        {:else if searchFilter}
          <span>No logs match filter "<strong>{searchFilter}</strong>"</span>
        {:else}
          <span>Waiting for container output...</span>
        {/if}
      </div>
    {:else}
      {#each filteredLogs as line, i}
        <div class="log-line">
          <span class="line-number">{i + 1}</span>
          <span class="line-text">{line}</span>
        </div>
      {/each}
    {/if}
  </div>

  <div class="logs-footer">
    <label class="auto-scroll-toggle">
      <input type="checkbox" bind:checked={autoScroll} />
      Auto-scroll to bottom
    </label>
    <span class="log-count">{filteredLogs.length} lines</span>
  </div>
</div>

<style>
  .live-logs-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    height: 100%;
  }

  .logs-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #18191e;
    padding: 0.45rem 0.75rem;
    border: 2px solid #282a36;
    border-radius: 6px;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .controls-left, .controls-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .control-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .container-badge {
    font-size: 0.78rem;
    color: #bbb;
    background: #111216;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #282a36;
  }

  .select-sm {
    background: #111216;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    outline: none;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: #111216;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.15rem 0.45rem;
    color: #888;
  }

  .input-filter {
    background: transparent;
    border: none;
    color: #eee;
    font-size: 0.78rem;
    outline: none;
    width: 140px;
  }

  .status-pill {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
  }

  .status-pill.connected {
    background: rgba(46, 213, 115, 0.15);
    color: #2ed573;
    border: 1px solid #2ed573;
  }

  .status-pill.disconnected {
    background: rgba(255, 71, 87, 0.15);
    color: #ff4757;
    border: 1px solid #ff4757;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .btn-xs {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .logs-viewport {
    height: 440px;
    background: #0d0e12;
    border: 2px solid #282a36;
    border-radius: 6px;
    padding: 0.6rem;
    overflow-y: auto;
    font-family: 'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace;
    font-size: 0.82rem;
    line-height: 1.45;
    box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
  }

  .empty-logs {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #666;
    font-style: italic;
  }

  .log-line {
    display: flex;
    gap: 0.75rem;
    word-break: break-all;
    white-space: pre-wrap;
  }

  .log-line:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .line-number {
    color: #444;
    user-select: none;
    min-width: 32px;
    text-align: right;
    font-size: 0.75rem;
  }

  .line-text {
    color: #cfd8dc;
  }

  .logs-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
    color: #777;
    padding: 0 0.25rem;
  }

  .auto-scroll-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
    user-select: none;
  }

  .log-count {
    font-family: monospace;
    color: #888;
  }
</style>

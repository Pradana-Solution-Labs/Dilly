<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import '@xterm/xterm/css/xterm.css';
  import { Terminal as TerminalIcon, RefreshCw, Layers, Power } from 'lucide-svelte';

  export let service: any;
  export let token: string;

  let terminalContainer: HTMLDivElement;
  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let ws: WebSocket | null = null;
  let isConnected = false;
  let containers: Array<{ id: string; name: string; service: string; state: string }> = [];
  let selectedContainerId = '';
  let resizeObserver: ResizeObserver | null = null;

  onMount(async () => {
    await fetchContainers();
    initTerminal();
    connectWebSocket();
  });

  onDestroy(() => {
    cleanup();
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
      console.warn('Failed to load containers for terminal:', e);
    }
  }

  function initTerminal() {
    if (!terminalContainer) return;

    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: "'Fira Code', 'Cascadia Code', Consolas, Monaco, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#0d0e12',
        foreground: '#e6edf3',
        cursor: '#64ffda',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#bfbfbf',
        brightBlack: '#4d4d4d',
        brightRed: '#ff6e67',
        brightGreen: '#5af78e',
        brightYellow: '#f4f99d',
        brightBlue: '#caa9fa',
        brightMagenta: '#ff92d0',
        brightCyan: '#9aedfe',
        brightWhite: '#e6e6e6',
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);

    setTimeout(() => {
      fitAddon?.fit();
    }, 50);

    // Keystroke forwarding
    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Terminal resize observer
    resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon?.fit();
        if (term && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      } catch {}
    });
    resizeObserver.observe(terminalContainer);
  }

  function connectWebSocket() {
    if (ws) {
      ws.close();
      ws = null;
    }

    if (term) {
      term.reset();
      term.writeln('\x1b[90mConnecting to container terminal...\x1b[0m');
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    let url = `${protocol}//${host}/api/services/${service.id}/terminal/ws?token=${encodeURIComponent(token)}`;
    if (selectedContainerId) {
      url += `&containerId=${selectedContainerId}`;
    }

    try {
      ws = new WebSocket(url);

      ws.onopen = () => {
        isConnected = true;
        if (term) {
          fitAddon?.fit();
          ws?.send(
            JSON.stringify({
              type: 'resize',
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      };

      ws.onmessage = (event) => {
        if (term) {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        isConnected = false;
        if (term) {
          term.writeln('\r\n\x1b[33m[Dilly] Connection closed.\x1b[0m');
        }
      };

      ws.onerror = () => {
        isConnected = false;
        if (term) {
          term.writeln('\r\n\x1b[31m[Dilly] Connection error.\x1b[0m');
        }
      };
    } catch (e: any) {
      if (term) {
        term.writeln(`\r\n\x1b[31mFailed to connect: ${e.message}\x1b[0m`);
      }
    }
  }

  function handleContainerChange() {
    connectWebSocket();
  }

  function cleanup() {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (term) {
      term.dispose();
      term = null;
    }
  }
</script>

<div class="terminal-wrapper">
  <div class="terminal-header">
    <div class="header-left">
      <TerminalIcon size={16} class="text-accent" />
      <span class="term-title">Web Terminal (Interactive Exec)</span>

      {#if containers.length > 1}
        <div class="container-select-group">
          <Layers size={13} class="text-muted" />
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
          Container: <strong>{containers[0].name}</strong>
        </span>
      {/if}
    </div>

    <div class="header-right">
      <div class="status-pill {isConnected ? 'connected' : 'disconnected'}">
        <span class="status-dot"></span>
        {isConnected ? 'Connected' : 'Disconnected'}
      </div>

      <button class="btn btn-secondary btn-xs" on:click={connectWebSocket} title="Reconnect terminal">
        <RefreshCw size={12} /> Reconnect
      </button>
    </div>
  </div>

  <div class="terminal-body" bind:this={terminalContainer}></div>

  <div class="terminal-footer">
    <span class="shortcut-tip">
      💡 Interactive TTY session attached to <code>/bin/sh</code> or <code>/bin/bash</code>. Standard shortcuts (Ctrl+C, Ctrl+D, clear) supported.
    </span>
    <span class="size-indicator">
      {term ? `${term.cols}x${term.rows}` : ''}
    </span>
  </div>
</div>

<style>
  .terminal-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    height: 100%;
  }

  .terminal-header {
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

  .header-left, .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .term-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #eee;
  }

  .container-select-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .select-sm {
    background: #111216;
    color: #eee;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.78rem;
    outline: none;
  }

  .container-badge {
    font-size: 0.78rem;
    color: #bbb;
    background: #111216;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #282a36;
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

  .terminal-body {
    height: 440px;
    background: #0d0e12;
    border: 2px solid #282a36;
    border-radius: 6px;
    padding: 0.5rem;
    box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
    overflow: hidden;
  }

  .terminal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
    color: #777;
    padding: 0 0.25rem;
  }

  .shortcut-tip code {
    background: #222;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    color: #64ffda;
  }

  .size-indicator {
    font-family: monospace;
    color: #888;
  }
</style>

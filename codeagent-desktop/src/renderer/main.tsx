import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBootstrap } from '../../electron/shared/api-types';
import { Workbench } from './app/App';
import './styles/tokens.css';
import './styles.css';
import './styles/panels.css';
import './styles/git.css';
import './styles/terminal.css';
import './styles/settings.css';
import './styles/settings-responsive.css';

const statusEl = document.getElementById('service-status');
const shellEl = document.getElementById('app');

function renderDegraded(bootstrap: DesktopBootstrap): void {
  if (!shellEl) return;
  while (shellEl.firstChild) shellEl.removeChild(shellEl.firstChild);
  const container = document.createElement('section');
  container.className = 'degraded';

  const heading = document.createElement('h1');
  heading.textContent = 'CodeAgent Desktop — Service 不可用';
  container.appendChild(heading);

  const detail = document.createElement('p');
  detail.textContent = bootstrap.message ?? '无法连接或启动 Business Service。';
  container.appendChild(detail);

  const diagnosticsList = document.createElement('ul');
  void window.codeAgentDesktop.diagnostics().then((diagnostics) => {
    const items = [
      `Service 状态：${diagnostics.serviceState}`,
      `owned 进程：${diagnostics.ownedProcess ? `pid ${diagnostics.ownedProcess.pid}, port ${diagnostics.ownedProcess.port}` : '无'}`,
      `token 加密存储：${diagnostics.encryptionAvailable ? '可用' : '不可用（会话内保存，不落盘）'}`,
      `诊断数据位置：${diagnostics.logLocation}`
    ];
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      diagnosticsList.appendChild(li);
    }
  });
  container.appendChild(diagnosticsList);

  const retryButton = document.createElement('button');
  retryButton.textContent = '重试连接';
  retryButton.addEventListener('click', () => {
    retryButton.disabled = true;
    void main();
  });
  container.appendChild(retryButton);

  const restartButton = document.createElement('button');
  // SHARED_ATTACH: the Service belongs to an external launcher — this button
  // only re-handshakes, so it is labeled as a re-check rather than a restart.
  const externalAttach = bootstrap.serviceMode === 'SHARED_ATTACH';
  restartButton.textContent = externalAttach ? '重新检测连接' : '重新启动 Service';
  if (externalAttach) restartButton.title = '外部 Service 由启动方管理；此处只重新握手';
  restartButton.addEventListener('click', () => {
    restartButton.disabled = true;
    void window.codeAgentDesktop.restartService().then((result) => {
      if (result.status === 'ATTACHED' || result.status === 'OWNED_READY') {
        location.reload();
      } else {
        renderDegraded(result);
      }
    });
  });
  container.appendChild(restartButton);

  // Never strand the user on this screen: entering the workbench is always an
  // option — surfaces degrade per-capability, and 设置 > Service can retry.
  const continueButton = document.createElement('button');
  continueButton.textContent = '仍要进入';
  continueButton.title = '打开工作台；Service 恢复前，会话与执行功能不可用，可在设置里重新检测';
  continueButton.addEventListener('click', () => renderConnected(bootstrap));
  container.appendChild(continueButton);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '不会显示任何伪造的会话数据；也可以先进入桌面，连接恢复前相关功能不可用。';
  container.appendChild(hint);

  shellEl.appendChild(container);
  if (statusEl) statusEl.textContent = `Service 状态：${bootstrap.status}`;
}

function renderConnected(bootstrap: DesktopBootstrap): void {
  if (!shellEl) return;
  const acsReady = bootstrap.status === 'ATTACHED' || bootstrap.status === 'OWNED_READY';
  const initialBanner = !acsReady && bootstrap.personalGatewayConfigured === true
    ? 'ACS 会话服务未连接；原生任务使用独立连接。'
    : bootstrap.message ?? null;
  while (shellEl.firstChild) shellEl.removeChild(shellEl.firstChild);
  const mount = document.createElement('div');
  mount.id = 'workbench-root';
  shellEl.appendChild(mount);

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 5000, refetchOnWindowFocus: false }
    }
  });

  createRoot(mount).render(
    <QueryClientProvider client={queryClient}>
      <Workbench capabilities={bootstrap.capabilities} protocolVersion={bootstrap.protocolVersion ?? null} initialBanner={initialBanner} personalGateway={bootstrap.personalGatewayConfigured === true} serviceDegraded={!acsReady} />
    </QueryClientProvider>
  );
}

async function main(): Promise<void> {
  try {
    const bootstrap = await window.codeAgentDesktop.bootstrap();
    const acsReady = bootstrap.status === 'ATTACHED' || bootstrap.status === 'OWNED_READY';
    if (acsReady || bootstrap.personalGatewayConfigured === true) {
      if (statusEl) {
        const facts = [`Service 状态：${bootstrap.status}`];
        if (acsReady) facts.push(`protocol ${bootstrap.protocolVersion ?? '?'}`);
        if (bootstrap.personalGatewayConfigured === true) facts.push('个人管理网关已配置');
        statusEl.textContent = facts.join(' · ');
      }
      renderConnected(bootstrap);
    } else {
      renderDegraded(bootstrap);
    }
  } catch {
    renderDegraded({ status: 'DEGRADED', message: '桌面与 Service 握手失败，请查看诊断' });
  }
}

void main();

#!/usr/bin/env node
// Проверка полного пути «установка → bind → probe → refresh → state» без
// реального роутера. Работает через публичный API панели.
//
//   node scripts/fake-agent-check.mjs \
//     --base https://routx.example.com \
//     --email admin@example.com --password '...'
//
// Или с готовой сессией:
//   --session <rc_session> --csrf <rc_csrf>
//
// Скрипт создаёт временный роутер и удаляет его в конце (--keep оставляет).

import { createHash, createHmac, randomBytes } from 'node:crypto';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? '' : fallback;
}

const BASE = (arg('base', process.env.ROUTX_URL ?? 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const NAME = arg('name', `AUTOTEST ${new Date().toISOString().slice(0, 16)}`);
const KEEP = process.argv.includes('--keep');

let session = arg('session', process.env.ROUTX_SESSION ?? '');
let csrf = arg('csrf', process.env.ROUTX_CSRF ?? '');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sign(token, method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', token)
    .update(`${method}\n${path}\n${ts}\n${nonce}\n${sha256(body)}`)
    .digest('hex');
  return {
    'x-rc-timestamp': ts,
    'x-rc-nonce': nonce,
    'x-rc-signature': signature,
  };
}

async function panel(method, path, body) {
  const headers = {
    accept: 'application/json',
    cookie: `rc_session=${session}; rc_csrf=${csrf}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!response.ok) fail(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return json;
}

async function login() {
  if (session && csrf) return;
  const email = arg('email', process.env.ROUTX_EMAIL ?? '');
  const password = arg('password', process.env.ROUTX_PASSWORD ?? '');
  if (!email || !password) fail('нужны --email/--password или --session/--csrf');
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) fail(`login → ${response.status} ${(await response.text()).slice(0, 300)}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [key, value] = pair.split('=');
    if (key === 'rc_session') session = value;
    if (key === 'rc_csrf') csrf = value;
  }
  if (!session || !csrf) fail('логин не вернул rc_session/rc_csrf (включена 2FA?)');
  ok('вход выполнен');
}

async function agent(token, method, path, body = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...sign(token, method, path, payload),
    },
    body: payload,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!response.ok) fail(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return json;
}

const STATE = {
  ok: true,
  state_hash: 'fake-agent-hash',
  managed: {
    'section.rc_main.action': 'connection',
    'section.rc_main.enabled': '1',
  },
  sections: [
    {
      section: 'rc_main',
      options: { action: 'connection', enabled: '1' },
      subscriptions: [],
      links: [],
      lists: {},
    },
  ],
};

async function respondToCommands(token) {
  for (;;) {
    const poll = await agent(token, 'POST', '/agent/v1/poll', {});
    const command = poll.command;
    if (!command) return;
    const result =
      command.op === 'read_state'
        ? { status: 'success', result: STATE }
        : { status: 'failed', error: { code: 'unsupported', message: 'fake-agent' } };
    await agent(token, 'POST', `/agent/v1/commands/${command.id}/result`, result);
    if (command.op === 'read_state') return;
  }
}

async function waitJob(token, id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await panel('GET', `/api/v1/jobs/${id}`);
    const job = response.job;
    if (['success', 'failed', 'timeout', 'cancelled'].includes(job.status)) {
      if (job.status !== 'success') fail(`задача ${job.type}: ${job.error?.code} ${job.error?.message}`);
      return job;
    }
    await respondToCommands(token);
  }
  fail('задача не завершилась за отведённое время');
}

async function main() {
  await login();

  const created = await panel('POST', '/api/v1/routers', { name: NAME, product_hint: 'tachyon' });
  const routerId = created.router.id;
  ok(`создан роутер ${routerId}`);

  try {
    const binding = await panel('POST', `/api/v1/routers/${routerId}/binding-token`);
    const bindResponse = await fetch(`${BASE}/agent/v1/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: binding.token,
        product: 'tachyon',
        agent_version: '1.5.52',
      }),
    });
    if (!bindResponse.ok) fail(`bind → ${bindResponse.status}`);
    const bound = await bindResponse.json();
    const token = bound.agent_token;
    if (!token) fail('bind не вернул agent_token');
    ok('bind выполнен');

    await agent(token, 'POST', '/agent/v1/probe', {
      agent_version: '1.5.52',
      product: 'tachyon',
      product_version: '1.8.2',
      platform_state: 'ok',
      arch: 'aarch64_cortex-a53',
      model: 'fake-agent',
      managed: {},
    });
    ok('probe отправлен');

    const refresh = await panel('POST', `/api/v1/routers/${routerId}/refresh`);
    await waitJob(token, refresh.job.id);
    ok('refresh_state выполнен');

    const state = await panel('GET', `/api/v1/routers/${routerId}/state`);
    const sections = state.state?.sections;
    if (!Array.isArray(sections) || sections.length === 0) {
      fail('после refresh в состоянии нет секций');
    }
    ok(`sections: ${sections.map((section) => section.section).join(', ')}`);

    const router = await panel('GET', `/api/v1/routers/${routerId}`);
    if (router.router.status !== 'online') fail(`роутер в статусе ${router.router.status}`);
    if (router.router.managed_section !== 'rc_main') {
      fail(`managed_section = ${JSON.stringify(router.router.managed_section)}`);
    }
    ok('роутер online, managed_section=rc_main');
  } finally {
    if (!KEEP) {
      await panel('DELETE', `/api/v1/routers/${routerId}`).catch(() => undefined);
      ok('временный роутер удалён');
    }
  }

  console.log('PASS: путь установки и чтения состояния работает');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

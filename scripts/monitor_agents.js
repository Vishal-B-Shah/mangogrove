#!/usr/bin/env node
const fs = require('fs');

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const text = await res.text();
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch (e) {
      return { ok: false, status: res.status, error: 'invalid_json', text };
    }
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err.message };
  }
}

function isFinishedReport(report) {
  if (!report) return false;
  const s = (report.status || '').toString().toLowerCase();
  if (!s) return !!report.finished || !!report.complete || !!report.done;
  return ['done', 'finished', 'success', 'failed', 'completed', 'error'].includes(s);
}

async function pollAgent(agent, timeoutMs) {
  const start = Date.now();
  const result = { id: agent.id, url: agent.url, attempts: 0 };

  while (Date.now() - start < timeoutMs) {
    result.attempts += 1;
    const res = await fetchJson(agent.url);
    if (res.ok) {
      result.raw = res.json;
      if (isFinishedReport(res.json)) {
        result.finished = true;
        result.report = res.json;
        return result;
      }
      // not finished yet
    } else {
      result.error = res.error || 'unknown_error';
      result.detail = res.detail || res.text || null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  result.timed_out = true;
  return result;
}

function computeOverallStatus(agentSummaries) {
  let anyFailed = false;
  let allDone = true;
  for (const s of Object.values(agentSummaries)) {
    const r = s.report || s.raw;
    const st = r && (r.status || '').toString().toLowerCase();
    if (s.timed_out || s.error) allDone = false;
    if (st && ['failed', 'error'].includes(st)) anyFailed = true;
    if (!isFinishedReport(r)) allDone = false;
  }
  if (allDone && !anyFailed) return 'success';
  if (anyFailed) return 'failed';
  return 'partial';
}

async function main() {
  const cfgPath = process.argv[2] || 'scripts/agents_config.json';
  const timeoutMs = parseInt(process.argv[3], 10) || DEFAULT_TIMEOUT_MS;

  if (!fs.existsSync(cfgPath)) {
    console.error('Config file not found:', cfgPath);
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) {
    console.error('Config must contain an "agents" array with at least one agent.');
    process.exit(2);
  }

  const pollers = cfg.agents.map((a) => pollAgent(a, timeoutMs));
  const results = await Promise.all(pollers);

  const agentSummaries = {};
  for (const res of results) {
    agentSummaries[res.id] = res;
  }

  const overall_status = computeOverallStatus(agentSummaries);

  const next_steps = [];
  if (overall_status === 'success') {
    next_steps.push('All agents completed successfully. No further action.');
  } else {
    next_steps.push('Inspect agents with timed_out or error fields in their summaries.');
    next_steps.push('Retry failed agents or extend the timeout and re-run the monitor.');
  }

  const out = { overall_status, agent_summaries: agentSummaries, next_steps };
  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

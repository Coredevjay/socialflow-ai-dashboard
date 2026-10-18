import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001/api/v1';
const TOKEN = __ENV.AUTH_TOKEN || '';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
};

// ── Scenarios ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { scenario: 'smoke' },
      exec: 'default',
    },
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 0 },
      ],
      tags: { scenario: 'load' },
      exec: 'default',
      startTime: '35s', // starts after smoke finishes
    },
    ai_concurrency: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '60s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 },
      ],
      tags: { scenario: 'ai_concurrency' },
      exec: 'aiConcurrencyScenario',
      startTime: '5m40s', // starts after load ends (35s + 5m) so thresholds aren't skewed
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],           // <1% errors
    http_req_duration: ['p(95)<2000'],        // 95th percentile under 2s
    'http_req_duration{endpoint:ai}': ['p(95)<5000'], // AI endpoints get 5s budget
    'http_req_duration{scenario:ai_concurrency}': ['p(95)<5000'],
  },
};

// ── Critical path helpers ─────────────────────────────────────────────────────

function testHealthCheck() {
  const res = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'health' } });
  check(res, { 'health: status 200': (r) => r.status === 200 });
}

function testAIGeneration() {
  const payload = JSON.stringify({
    imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=',
    mimeType: 'image/jpeg',
    context: 'social media post',
  });
  const res = http.post(`${BASE_URL}/ai/analyze-image`, payload, {
    headers,
    tags: { endpoint: 'ai' },
  });
  check(res, { 'ai: status 200 or 422': (r) => [200, 422].includes(r.status) });
}

function testPostPublishing() {
  // TikTok publish endpoint (post scheduling / publishing critical path)
  const payload = JSON.stringify({
    title: 'k6 perf test post',
    videoUrl: 'https://example.com/test.mp4',
  });
  const res = http.post(`${BASE_URL}/tiktok/upload`, payload, {
    headers,
    tags: { endpoint: 'publish' },
  });
  // 401/403 expected without real credentials — we're measuring latency/availability
  check(res, { 'publish: responded': (r) => r.status < 500 });
}

// ── Default function ──────────────────────────────────────────────────────────

export default function () {
  testHealthCheck();
  sleep(0.5);

  testAIGeneration();
  sleep(1);

  testPostPublishing();
  sleep(0.5);
}

// ── AI concurrency scenario (ramp 1→50 VUs over 60s, p95 < 5s) ───────────────

export function aiConcurrencyScenario() {
  testAIGeneration();
  sleep(0.5);
}

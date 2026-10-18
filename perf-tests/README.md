# Performance Benchmarking with k6

## Setup

Install k6: https://k6.io/docs/get-started/installation/

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Running

```bash
# Full run (smoke → load → ai_concurrency, ~7 min total)
BASE_URL=http://localhost:3001/api/v1 AUTH_TOKEN=<your_token> \
  k6 run perf-tests/load-test.js

# Output results to JSON for baseline tracking
k6 run --out json=perf-tests/results.json perf-tests/load-test.js
```

## Scenarios

Scenarios run in sequence via `startTime` so they don't overlap:

| Scenario | Start | VUs | Duration | Exec | Purpose |
|----------|-------|-----|----------|------|---------|
| smoke    | 0s    | 1   | 30s      | `default` | Verify endpoints respond correctly |
| load     | 35s   | 0→20→0 | 5m  | `default` | Measure throughput and latency under realistic load |
| ai_concurrency | 5m40s | 1→50→0 | 100s | `aiConcurrencyScenario` | AI endpoint concurrency (p95 < 5s) |

## Thresholds

| Metric | Threshold |
|--------|-----------|
| Error rate | < 1% |
| p95 latency (general) | < 2000ms |
| p95 latency (AI endpoints) | < 5000ms |

## Critical Paths Tested

- `GET /api/v1/health` — baseline availability
- `POST /api/v1/ai/analyze-image` — AI content generation
- `POST /api/v1/tiktok/upload` — post publishing

## Baseline Results

Run the load test and record results here after each significant release to track performance regressions.

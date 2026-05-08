# RPOW CLI CUDA Miner

Unofficial RPOW2 command-line miner with native CPU mining and high-throughput NVIDIA CUDA mining.

This fork is tuned for a Linux CUDA server with 8x NVIDIA GeForce RTX 5090 GPUs. The main production path is the persistent CUDA pool:

```bash
node rpow-cli.js pool --engine cuda --cuda-devices 0,1,2,3,4,5,6,7
```

Use this only with your own account and follow the service rules of the RPOW2 site.

## What This Repo Does

- Keeps the normal RPOW2 pipeline: session/login, `POST /challenge`, local proof-of-work, `POST /mint`.
- Supports importing an existing browser session from a local cookie file.
- Supports three engines:
  - `cuda` for NVIDIA GPUs.
  - `native` for CPU mining through `rpow-native-miner`.
  - `node` as a slow JavaScript fallback.
- Uses persistent CUDA workers in `pool` mode so CUDA process/context startup is not paid for every challenge.
- Fetches challenges in parallel, solves in parallel, and submits solved mints in parallel.
- Writes successful mint receipts to `.rpow-mints.jsonl`.
- Does not print cookie/session values.
- Ignores local secrets, state files, logs, and compiled binaries through `.gitignore`.

## Repository

```bash
git clone https://github.com/gamedevod/rpow-cli-cuda-miner.git
cd rpow-cli-cuda-miner
```

## Files

```text
rpow-cli.js              CLI: auth/session, API requests, mining orchestration.
rpow-cuda-miner.cu       CUDA miner with one-shot mode and persistent worker mode.
rpow-native-miner.c      Native CPU miner.
rpow-miner-worker.js     Slow JavaScript fallback miner.
build-cuda.sh            CUDA build helper.
build-native.sh          Linux/macOS native CPU build helper.
build-native.ps1         Windows native CPU build helper.
.gitignore               Keeps cookies/state/logs/binaries out of git.
```

## Safety Rules

Never commit or publish these files:

```text
.rpow-cookies.txt
.rpow-cli-state.json
.rpow-mints.jsonl
*.log
rpow-cuda-miner
rpow-native-miner
```

Before pushing:

```bash
git status --short
git ls-files .rpow-cookies.txt .rpow-cli-state.json .rpow-mints.jsonl pool.log miner-0.log
```

The second command should print nothing.

## Server Requirements

For the 8x RTX 5090 setup:

- Linux server.
- Node.js 18+.
- NVIDIA driver visible through `nvidia-smi`.
- CUDA Toolkit 12.8+ or CUDA 13.x.
- 8x RTX 5090 GPUs, compute capability `12.0`.

Check the server:

```bash
node -v
nvidia-smi
nvidia-smi --query-gpu=name,compute_cap --format=csv
nvcc --version
uname -a
```

Expected GPU shape for this setup:

```text
NVIDIA GeForce RTX 5090, 12.0
```

If `nvcc` is missing or too old, install CUDA Toolkit 12.8+ or CUDA 13.x first. Do not install drivers/toolkits blindly on a rented server without checking the provider image.

## Build CUDA Miner

```bash
chmod +x build-cuda.sh
./build-cuda.sh
```

For RTX 5090, `build-cuda.sh` should detect compute capability `12.0` and build with `sm_120`.

If auto-detection is unavailable:

```bash
CUDA_COMPUTE_CAP=12.0 ./build-cuda.sh
```

Check that the binary exists:

```bash
ls -lh ./rpow-cuda-miner
```

## CUDA Tests

One-shot CUDA self-test:

```bash
./rpow-cuda-miner --self-test --device 0
```

Persistent worker self-test:

```bash
printf '%s\n' \
  '{"id":"test","prefix":"00","difficulty":8,"start":"0","cutoff_ms":"0"}' \
  '{"type":"shutdown"}' | ./rpow-cuda-miner --worker --device 0
```

Raw kernel benchmark without API latency:

```bash
./rpow-cuda-miner \
  --benchmark-ms 5000 \
  --prefix 00 \
  --device 0 \
  --blocks 8192 \
  --batch-size 1073741824
```

On RTX 5090 this repo has measured about `20 GH/s` per card in raw benchmark mode. Real mint rate can be lower because it also depends on challenge latency, mint latency, backend limits, expired challenges, and API errors.

## Cookie Session

The CLI can use an existing browser session from a local cookie file. Do not paste cookies into chat, commits, GitHub issues, or logs.

Create `.rpow-cookies.txt` in the repo directory. The file must contain exactly one Cookie header line:

```text
name=value; another=value
```

Recommended file permissions:

```bash
chmod 600 .rpow-cookies.txt
wc -l .rpow-cookies.txt
```

`wc -l` should show `1`.

Verify the session:

```bash
node rpow-cli.js me --cookie-file .rpow-cookies.txt
```

If this returns `login required` or `401`, the cookie is not an active RPOW2 session. Export a fresh Cookie header from the browser and replace the local file.

## Recommended Production Run: 8x RTX 5090 Pool

Stop old miners first:

```bash
pkill -f "node rpow-cli.js"
pkill -f "rpow-cuda-miner"
```

Start the persistent CUDA pool:

```bash
node rpow-cli.js pool \
  --engine cuda \
  --cuda-devices 0,1,2,3,4,5,6,7 \
  --challenge-buffer 300 \
  --prefetch-workers 300 \
  --solve-workers 8 \
  --mint-workers 300 \
  --cuda-blocks 32768 \
  --cuda-batch-size 1073741824 \
  --timeout 60000 \
  --retry-delay-ms 2000 \
  --stats-every-ms 5000 \
  --miner-id pool-8x5090 \
  --cookie-file .rpow-cookies.txt > pool.log 2>&1 &
```

Watch logs:

```bash
tail -f pool.log
```

Stop behavior:

- First `Ctrl+C` or `SIGTERM`: graceful stop. The pool stops accepting new challenges and finishes in-flight work.
- Second `Ctrl+C`: force stop. CUDA worker processes are terminated immediately.

Force stop from another shell:

```bash
pkill -f "node rpow-cli.js"
pkill -f "rpow-cuda-miner"
```

`pool` runs continuously when `--count` is omitted. To stop after a target number of accepted mints:

```bash
node rpow-cli.js pool --count 1000 --engine cuda --cuda-devices 0,1,2,3,4,5,6,7 --cookie-file .rpow-cookies.txt
```

## Pool Architecture

`pool` has three parallel stages:

```text
challenge fetchers -> challenge queue -> persistent CUDA workers -> solution queue -> mint workers
```

The important difference from one-shot `mine --engine cuda`:

- `mine` starts `rpow-cuda-miner` for each challenge.
- `pool` starts long-lived CUDA workers and sends tasks through stdin/stdout JSONL.

This avoids CUDA process/context startup overhead for every token.

## Pool Metrics

`pool stats` logs include:

```text
requested
request_failed
solved
accepted
accepted_per_min
recent_accepted_per_min
recent_requested_per_min
recent_solved_per_min
mint_failed
solve_failed
challenge_queue
solution_queue
active_solves
active_mints
failures
```

Read the bottleneck from these counters:

- `recent_solved_per_min` high, `recent_accepted_per_min` low: mint/API bottleneck.
- `challenge_queue` near zero and GPUs idle: not enough challenge prefetch or API request latency.
- `solution_queue` growing: mint workers/API are slower than solvers.
- Many `429`, `502`, or `5xx`: reduce API parallelism.
- Many `expired`: challenge buffer is too large or mint latency is too high.

## Tuning

Aggressive 8x RTX 5090 starting point:

```bash
--challenge-buffer 300 --prefetch-workers 300 --solve-workers 8 --mint-workers 300
```

If API errors increase:

```bash
--challenge-buffer 100 --prefetch-workers 100 --mint-workers 100
```

If GPUs are idle and API is healthy:

```bash
--challenge-buffer 600 --prefetch-workers 600 --mint-workers 300
```

CUDA settings used for the 8x RTX 5090 setup:

```bash
--cuda-blocks 32768
--cuda-batch-size 1073741824
```

Benchmark different block counts:

```bash
./rpow-cuda-miner --benchmark-ms 5000 --prefix 00 --device 0 --blocks 4096  --batch-size 1073741824
./rpow-cuda-miner --benchmark-ms 5000 --prefix 00 --device 0 --blocks 8192  --batch-size 1073741824
./rpow-cuda-miner --benchmark-ms 5000 --prefix 00 --device 0 --blocks 16384 --batch-size 1073741824
./rpow-cuda-miner --benchmark-ms 5000 --prefix 00 --device 0 --blocks 32768 --batch-size 1073741824
```

## Smaller Tests

Test backend behavior before a large continuous run:

```bash
node rpow-cli.js pool-test \
  --challenges 30 \
  --prefetch-workers 30 \
  --solve-workers 8 \
  --mint-workers 30 \
  --engine cuda \
  --cuda-devices 0,1,2,3,4,5,6,7 \
  --cuda-blocks 32768 \
  --cuda-batch-size 1073741824 \
  --timeout 60000 \
  --retry-delay-ms 2000 \
  --cookie-file .rpow-cookies.txt
```

A healthy result looks like:

```text
pool-test complete requested=30 request_failed=0 solved=30 accepted=30 mint_failed=0 solve_failed=0 failures={}
```

Run one CUDA mint:

```bash
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0 --cookie-file .rpow-cookies.txt
```

## CPU Native Fallback

Build native CPU miner:

```bash
chmod +x build-native.sh
./build-native.sh
```

Run CPU mining:

```bash
node rpow-cli.js mine --count 1 --workers 8 --engine native --cookie-file .rpow-cookies.txt
```

JavaScript fallback:

```bash
node rpow-cli.js mine --count 1 --workers 8 --engine node --cookie-file .rpow-cookies.txt
```

## CLI Commands

```bash
node rpow-cli.js map
node rpow-cli.js cookies --cookie-file .rpow-cookies.txt
node rpow-cli.js me --cookie-file .rpow-cookies.txt
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0 --cookie-file .rpow-cookies.txt
node rpow-cli.js pool --engine cuda --cuda-devices 0,1,2,3,4,5,6,7 --cookie-file .rpow-cookies.txt
node rpow-cli.js pool-test --challenges 30 --engine cuda --cuda-devices 0,1,2,3,4,5,6,7 --cookie-file .rpow-cookies.txt
node rpow-cli.js activity --cookie-file .rpow-cookies.txt
node rpow-cli.js send --to user@example.com --amount 1 --cookie-file .rpow-cookies.txt
node rpow-cli.js ledger
node rpow-cli.js logout
```

Magic-link login is still available:

```bash
node rpow-cli.js login --email you@example.com
node rpow-cli.js complete-login --link "https://..."
```

## Mint Receipts

Successful mints are appended to:

```text
.rpow-mints.jsonl
```

Each JSON line contains:

- `miner_id`
- token id
- challenge id
- solution nonce
- digest
- receipt hash
- engine metadata

This is useful when multiple miners use one account. Use distinct miner ids:

```bash
--miner-id pool-8x5090
--miner-id rtx5090-0
--miner-id macbook-native
```

The receipt log does not contain cookies.

## Troubleshooting

### `login required` / `401`

The cookie file does not contain an active RPOW2 session. Replace `.rpow-cookies.txt` with a fresh one-line Cookie header from the browser, then run:

```bash
node rpow-cli.js me --cookie-file .rpow-cookies.txt
```

### `nvcc not found`

Install CUDA Toolkit 12.8+ or CUDA 13.x on the server, then rebuild:

```bash
./build-cuda.sh
```

### Low token rate with high raw GH/s

Raw CUDA speed is not the same as accepted tokens per minute. Check `pool stats`:

- If `solved` grows faster than `accepted`, the bottleneck is mint/API.
- If `request_failed` grows, reduce `prefetch-workers`.
- If `mint_failed` grows with `expired`, reduce `challenge-buffer`.
- If GPUs are idle, increase `challenge-buffer` and `prefetch-workers`.

### Stop all miners

```bash
pkill -f "node rpow-cli.js"
pkill -f "rpow-cuda-miner"
```

## Security Notes

The CLI restricts requests to known RPOW2 hosts:

```text
api.rpow2.com
rpow2.com
www.rpow2.com
```

Verbose logs do not print cookies or magic-link query strings. Keep `.rpow-cookies.txt` and `.rpow-cli-state.json` local only.

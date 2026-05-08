# RPOW Native CLI Portable

Portable command-line client for RPOW2 with a native C proof-of-work miner. It reproduces the site's browser API pipeline without opening the web UI: magic-link login, session cookies, challenge request, local C mining, minting, sending, activity and ledger queries.

This is an unofficial tool. Use it only with your own account and follow the service rules of the RPOW2 site.

## Features

- Uses the native C miner as the recommended mining engine.
- Includes the native C miner source and beginner-friendly build instructions.
- Uses Node.js 18+ only for CLI orchestration, HTTP requests and session handling.
- Supports magic-link login and local session persistence.
- Keeps a slower JavaScript miner only as a fallback.
- Resumes an unfinished challenge from the saved nonce when possible.
- Logs HTTP retries and mining progress without printing cookies or magic-link query strings.
- Restricts requests to the known RPOW2 site/API hosts.

## Files

```text
rpow-native-miner.c      Native C miner source, buildable with gcc/clang.
rpow-cuda-miner.cu       CUDA miner source for NVIDIA GPUs.
build-native.ps1         Windows helper script for building rpow-native-miner.exe.
build-native.sh          macOS/Linux helper script for building rpow-native-miner.
build-cuda.sh            Linux helper script for building rpow-cuda-miner with nvcc.
rpow-cli.js              Node.js CLI wrapper for login, API requests and miner orchestration.
rpow-miner-worker.js     Slower JavaScript fallback miner used only with `--engine node`.
index.js                 Frontend bundle used for API discovery by `map`.
README.md                Public usage guide.
PUBLICATION_GUIDE.md     Maintainer notes for publishing this repo.
```

Runtime state is stored in `.rpow-cli-state.json`. It contains account email, cookies/session data, current challenge and last mint metadata. Do not publish it.

## Requirements

- Node.js 18 or newer for the CLI wrapper.
- A native C miner binary built from `rpow-native-miner.c`:
  - Windows output name: `rpow-native-miner.exe`.
  - Linux/macOS output name: `rpow-native-miner`.
- Optional: gcc/clang if you want to rebuild the native C miner yourself.
- Optional for NVIDIA GPU mining: NVIDIA driver, `nvidia-smi`, and CUDA Toolkit 12.8+ or CUDA 13.x. Blackwell/B200 GPUs require a Toolkit new enough to compile `sm_100`.

Check Node.js:

```powershell
node -v
```

## Quick Start

Open PowerShell in the repository folder:

```powershell
.\build-native.ps1
node rpow-cli.js map
node rpow-cli.js login --email you@example.com
node rpow-cli.js complete-login --link "MAGIC_LINK_FROM_EMAIL"
node rpow-cli.js mine --count 1 --engine native
```

On macOS/Linux, build first with:

```bash
./build-native.sh
```

For a longer native C mining run:

```powershell
node rpow-cli.js mine --count 10 --workers 8 --engine native
```

If the native C miner is unavailable, use the slower JavaScript fallback:

```powershell
node rpow-cli.js mine --count 1 --workers 8 --engine node
```

On a CUDA server, build the GPU miner and run:

```bash
./build-cuda.sh
./rpow-cuda-miner --self-test --device 0
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0
```

## Login With an Existing Cookie Header

You can import an existing browser session from a local file instead of using the magic-link flow. Create `.rpow-cookies.txt` in the repository folder and put one Cookie header line in it:

```text
name=value; another=value
```

Do not commit or share this file. It is ignored by `.gitignore`.

Verify the session:

```bash
node rpow-cli.js me --cookie-file .rpow-cookies.txt
```

Mine one token with the native engine:

```bash
node rpow-cli.js mine --count 1 --workers 8 --engine native --cookie-file .rpow-cookies.txt
```

## Native C Setup for Beginners

The CLI itself runs with Node.js, but mining should run through the C binary. Build the C miner once, keep the binary in the same folder as `rpow-cli.js`, then run the CLI with `--engine native`.

### Windows: Build the C Miner

Check that Node.js works:

```powershell
node -v
```

Install a C compiler if you do not have one:

1. Install MSYS2 from `https://www.msys2.org/`.
2. Open "MSYS2 MinGW x64" from the Start menu.
3. Install gcc:

```bash
pacman -S --needed mingw-w64-x86_64-gcc
```

Build from PowerShell if `gcc` is available in PATH:

```powershell
.\build-native.ps1
```

If PowerShell cannot find `gcc`, build from the MSYS2 MinGW x64 shell instead.

Go to the project folder. Example:

```bash
cd /c/Users/YOUR_NAME/Downloads/rpow-native-cli-portable
```

Build the C miner:

```bash
gcc -O3 -march=native -pthread rpow-native-miner.c -o rpow-native-miner.exe
```

Check that the binary exists:

```bash
ls -l rpow-native-miner.exe
```

Go back to PowerShell and run:

```powershell
node rpow-cli.js mine --count 1 --workers 8 --engine native
```

### Linux/macOS: Build the C Miner

Install a compiler first.

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install build-essential nodejs
```

macOS with Xcode Command Line Tools:

```bash
xcode-select --install
```

Build the native C miner:

```bash
./build-native.sh
```

Run mining with the C engine:

```bash
node rpow-cli.js mine --count 1 --workers 8 --engine native
```

The CLI looks for `rpow-native-miner.exe` on Windows and `rpow-native-miner` on macOS/Linux. If no native binary exists, `--engine native` will fail and tell you to build the native miner.

### NVIDIA CUDA Setup

CUDA mining keeps the same CLI pipeline: session cookies or magic-link login, `POST /challenge`, local GPU proof-of-work, and `POST /mint`.

Check the server:

```bash
nvidia-smi
nvidia-smi --query-gpu=name,compute_cap --format=csv
nvcc --version
uname -a
```

For NVIDIA B200/Blackwell, install CUDA Toolkit 12.8+ or CUDA 13.x before building. `build-cuda.sh` stops if `nvcc` is missing or too old. It detects the first GPU compute capability and builds with matching SASS plus PTX fallback. For compute capability `10.0`, it uses `sm_100`.

Build:

```bash
chmod +x build-cuda.sh
./build-cuda.sh
```

If the server cannot run `nvidia-smi` during build but you know the target capability, pass it explicitly:

```bash
CUDA_COMPUTE_CAP=10.0 ./build-cuda.sh
```

Quick CUDA self-test:

```bash
./rpow-cuda-miner --self-test --device 0
```

Measure raw CUDA kernel speed without API latency or early-solution timing noise:

```bash
./rpow-cuda-miner --benchmark-ms 5000 --prefix 00 --device 0 --blocks 8192 --batch-size 1073741824
```

Run one mint on GPU:

```bash
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0 --cookie-file .rpow-cookies.txt
```

Test whether the backend accepts a pre-fetched pool of challenges. This requests all challenges first, solves them on CUDA, then submits all solutions:

```bash
node rpow-cli.js pool-test --challenges 10 --prefetch-workers 10 --solve-workers 8 --mint-workers 10 --engine cuda --cuda-devices 0,1,2,3,4,5,6,7 --cuda-blocks 32768 --cuda-batch-size 1073741824 --timeout 60000 --retry-delay-ms 2000 --cookie-file .rpow-cookies.txt
```

Use the final `pool-test complete` line to decide whether larger local pooling is viable. If most mints return `already claimed`, `invalid`, or `expired`, the backend does not support a large prefetch pool for one account.

Tune batch size if progress updates are too slow or kernel launches are too frequent:

```bash
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0 --cuda-batch-size 67108864 --cookie-file .rpow-cookies.txt
```

Tune CUDA block count if the GPU is underutilized. By default the miner uses `SM count * 32` blocks with 256 threads per block:

```bash
node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0 --cuda-blocks 8192 --cookie-file .rpow-cookies.txt
```

## Commands

### `map`

Shows the API origin, endpoints found in `index.js`, and the actual pipeline used by the CLI.

```powershell
node rpow-cli.js map
```

### `login`

Requests a magic login link through `POST /auth/request`.

```powershell
node rpow-cli.js login --email you@example.com
```

If the API returns a rate limit, the command stops instead of repeatedly requesting email links.

### `complete-login`

Accepts the magic link from email, follows it, stores session cookies in the local state file and verifies the session through `GET /me`.

```powershell
node rpow-cli.js complete-login --link "https://..."
```

### `me`

Shows the current user, balance and counters. Requires an active session.

```powershell
node rpow-cli.js me
```

### `mine`

Runs the mining pipeline: `GET /me`, `POST /challenge`, local native C proof-of-work by default, `POST /mint`.

```powershell
node rpow-cli.js mine --count 1 --engine native
```

### `run`

Alias for `mine`, useful for multiple tokens.

```powershell
node rpow-cli.js run --count 3
```

### `send`

Sends RPOW to another email through `POST /send`. Requires an active session and balance.

```powershell
node rpow-cli.js send --to friend@example.com --amount 1
```

### `activity`

Shows account activity through `GET /activity`.

```powershell
node rpow-cli.js activity
```

### `ledger`

Shows public ledger statistics. No session is required.

```powershell
node rpow-cli.js ledger
```

### `logout`

Calls `POST /auth/logout` and clears local cookies.

```powershell
node rpow-cli.js logout
```

## Options

### `--state`

Path to the state file. Default: `.rpow-cli-state.json`.

```powershell
node rpow-cli.js mine --state .my-rpow-state.json
```

### `--cookie-file`

Imports cookies from a local file containing one Cookie header line, saves them into `.rpow-cli-state.json`, and uses them for authenticated commands.

```powershell
node rpow-cli.js me --cookie-file .rpow-cookies.txt
```

### `--timeout`

HTTP request timeout in milliseconds. Default: `20000`.

```powershell
node rpow-cli.js ledger --timeout 10000
```

### `--retries`

Number of retries for transient failures: timeout, `429`, `408`, `425`, `5xx`. Default: `5`.

```powershell
node rpow-cli.js mine --retries 8
```

### `--retry-delay-ms`

Fixed delay between transient request retries. Default: `2000`.

```powershell
node rpow-cli.js mine --timeout 60000 --retry-delay-ms 2000
```

### `--log-every-ms`

How often mining progress is logged and nonce progress is saved. Default: `5000`.

```powershell
node rpow-cli.js mine --log-every-ms 2000
```

### `--miner-id`

Sets a local miner identity stored in `.rpow-cli-state.json` and written into every successful mint receipt. Use different names when multiple miners share one account.

```powershell
node rpow-cli.js mine --miner-id macbook-pro --engine native
```

### `--mint-log`

Path to the successful mint receipt log. Default: `.rpow-mints.jsonl`. Each accepted mint appends one JSON line with the miner id, token id, challenge id, solution nonce, verified SHA-256 digest and a `receipt_hash`.

```powershell
node rpow-cli.js mine --mint-log .rpow-mints.jsonl
```

### `--workers`

Number of CPU worker threads. By default the CLI uses up to 8 workers while leaving one logical CPU for the system.

```powershell
node rpow-cli.js mine --workers 8
```

If the system becomes unresponsive, lower the value:

```powershell
node rpow-cli.js mine --workers 4
```

### `--engine`

Mining engine: `native`, `node`, or `cuda`. `native` is the recommended CPU engine. `cuda` uses `rpow-cuda-miner` on NVIDIA GPUs.

```powershell
node rpow-cli.js mine --engine native --workers 8
node rpow-cli.js mine --engine node --workers 8
node rpow-cli.js mine --engine cuda --cuda-device 0
```

### `--cuda-device`

CUDA device index for `--engine cuda`. Default: `0`.

```powershell
node rpow-cli.js mine --engine cuda --cuda-device 0
```

### `--cuda-batch-size`

Number of nonces tested per CUDA kernel launch. Default: `1073741824`.

```powershell
node rpow-cli.js mine --engine cuda --cuda-batch-size 1073741824
```

### `--cuda-blocks`

CUDA block count for `--engine cuda`. Default: auto-detected as `SM count * 32`.

```powershell
node rpow-cli.js mine --engine cuda --cuda-blocks 8192
```

### `--fresh`

Ignores a saved challenge and requests a fresh one through `POST /challenge`.

```powershell
node rpow-cli.js mine --fresh
```

### `--verbose`

Enables detailed HTTP logs.

```powershell
node rpow-cli.js mine --verbose
```

Or with an environment variable:

```powershell
$env:RPOW_VERBOSE=1
node rpow-cli.js mine
```

Disable colors:

```powershell
$env:NO_COLOR=1
node rpow-cli.js mine
```

## Native C Miner

The repository is intended to be used with the native C miner. Build it from source before using `--engine native`.

Windows:

```powershell
.\build-native.ps1
```

Linux/macOS:

```bash
./build-native.sh
```

CUDA Linux server:

```bash
./build-cuda.sh
./rpow-cuda-miner --self-test --device 0
```

The JavaScript engine exists only as a slower fallback for systems without a compiled miner.

## Logs and Privacy

Verbose HTTP logs use this shape:

```text
HTTP -> method/url/attempt/has_body/has_cookie
HTTP <- method/url/attempt/status/ms/set_cookie/retry_after_ms
```

Cookies and magic-link query strings are not printed.

Mining progress logs look like this:

```text
mining hashes=... nonce=... workers=8 engine=native speed="21.00 MH/s"
```

Successful mints are also appended to `.rpow-mints.jsonl` as local proof receipts. When multiple miners use the same account, give each miner a distinct id:

```bash
node rpow-cli.js mine --count 1000000 --workers 8 --engine native --miner-id macbook-pro --cookie-file .rpow-cookies.txt
```

The terminal success line includes `miner_id`, `token_id`, `challenge_id`, `solution_nonce` and `receipt_hash`. The JSONL receipt contains the full proof data without cookies.

## Retry and Resume Behavior

The CLI retries transient request failures with exponential backoff and jitter.

`POST /auth/request` is handled conservatively: on rate limit, the CLI stops and asks you to wait instead of spamming email requests.

The state file stores cookies, current challenge, nonce progress and last mint metadata. If mining stops unexpectedly, rerun:

```powershell
node rpow-cli.js mine --count 1
```

The CLI will resume from the saved nonce if the challenge is still valid.

## API Pipeline

The site frontend currently uses:

```text
POST /auth/request   { email }
GET  /me
POST /challenge
POST /mint           { challenge_id, solution_nonce }
POST /send           { recipient_email, amount, idempotency_key }
GET  /activity
GET  /ledger
POST /auth/logout
```

For minting, the CLI requests a challenge, mines `SHA-256(nonce_prefix || uint64-le nonce)` locally, then submits the solution through `POST /mint`.

## Security Notes

The CLI allows requests only to these hosts:

```text
api.rpow2.com
rpow2.com
www.rpow2.com
```

Before publishing or sharing a build, make sure `.rpow-cli-state.json` is not included.

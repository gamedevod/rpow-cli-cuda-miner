#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v nvcc >/dev/null 2>&1; then
  echo "CUDA Toolkit nvcc not found." >&2
  echo "Install CUDA Toolkit 12.8+ or CUDA 13.x for NVIDIA Blackwell/B200, then rerun ./build-cuda.sh." >&2
  exit 1
fi

version_text="$(nvcc --version 2>/dev/null || true)"
release="$(printf "%s\n" "$version_text" | sed -n 's/.*release \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1.\2/p' | head -n 1)"
major="$(printf "%s" "$release" | cut -d. -f1)"
minor="$(printf "%s" "$release" | cut -d. -f2)"

if [ -z "$major" ] || [ -z "$minor" ]; then
  echo "Could not determine nvcc version. CUDA 12.8+ or CUDA 13.x is required for Blackwell/B200." >&2
  exit 1
fi

if [ "$major" -lt 12 ] || { [ "$major" -eq 12 ] && [ "$minor" -lt 8 ]; }; then
  echo "CUDA Toolkit $release is too old for Blackwell/B200." >&2
  echo "Install CUDA Toolkit 12.8+ or CUDA 13.x, then rerun ./build-cuda.sh." >&2
  exit 1
fi

compute_cap="${CUDA_COMPUTE_CAP:-}"
if [ -z "$compute_cap" ] && command -v nvidia-smi >/dev/null 2>&1; then
  compute_cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d '[:space:]')"
fi

if [ -z "$compute_cap" ]; then
  echo "Could not detect GPU compute capability." >&2
  echo "Set CUDA_COMPUTE_CAP, for example: CUDA_COMPUTE_CAP=10.0 ./build-cuda.sh" >&2
  exit 1
fi

arch_num="$(printf "%s" "$compute_cap" | tr -d '.')"
case "$arch_num" in
  *[!0-9]*|"")
    echo "Bad compute capability: $compute_cap" >&2
    exit 1
    ;;
esac

echo "Using CUDA compute capability $compute_cap (sm_$arch_num)"
nvcc -O3 -std=c++17 \
  -gencode "arch=compute_${arch_num},code=sm_${arch_num}" \
  -gencode "arch=compute_${arch_num},code=compute_${arch_num}" \
  rpow-cuda-miner.cu -o rpow-cuda-miner

chmod +x rpow-cuda-miner

echo "Built ./rpow-cuda-miner"
echo "Run: node rpow-cli.js mine --count 1 --engine cuda --cuda-device 0"

#include <cuda_runtime.h>

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <chrono>

typedef struct {
  uint8_t data[64];
  uint32_t datalen;
  uint64_t bitlen;
  uint32_t state[8];
} sha256_ctx;

__constant__ uint8_t c_prefix[64];
__constant__ size_t c_prefix_len;
__constant__ uint32_t c_base_words[16];
__constant__ size_t c_nonce_offset;

__constant__ uint32_t k[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define ROTR(a,b) (((a) >> (b)) | ((a) << (32-(b))))
#define CH(x,y,z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x,y,z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x,2) ^ ROTR(x,13) ^ ROTR(x,22))
#define EP1(x) (ROTR(x,6) ^ ROTR(x,11) ^ ROTR(x,25))
#define SIG0(x) (ROTR(x,7) ^ ROTR(x,18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x,17) ^ ROTR(x,19) ^ ((x) >> 10))

__device__ __forceinline__ void sha256_transform(sha256_ctx *ctx, const uint8_t data[]) {
  uint32_t a,b,c,d,e,f,g,h,i,j,t1,t2,m[64];
  for (i = 0, j = 0; i < 16; ++i, j += 4)
    m[i] = ((uint32_t)data[j] << 24) | ((uint32_t)data[j+1] << 16) | ((uint32_t)data[j+2] << 8) | data[j+3];
  for (; i < 64; ++i) m[i] = SIG1(m[i-2]) + m[i-7] + SIG0(m[i-15]) + m[i-16];
  a=ctx->state[0]; b=ctx->state[1]; c=ctx->state[2]; d=ctx->state[3];
  e=ctx->state[4]; f=ctx->state[5]; g=ctx->state[6]; h=ctx->state[7];
  for (i = 0; i < 64; ++i) {
    t1 = h + EP1(e) + CH(e,f,g) + k[i] + m[i];
    t2 = EP0(a) + MAJ(a,b,c);
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  ctx->state[0]+=a; ctx->state[1]+=b; ctx->state[2]+=c; ctx->state[3]+=d;
  ctx->state[4]+=e; ctx->state[5]+=f; ctx->state[6]+=g; ctx->state[7]+=h;
}

__device__ __forceinline__ void sha256_init(sha256_ctx *ctx) {
  ctx->datalen = 0; ctx->bitlen = 0;
  ctx->state[0]=0x6a09e667; ctx->state[1]=0xbb67ae85; ctx->state[2]=0x3c6ef372; ctx->state[3]=0xa54ff53a;
  ctx->state[4]=0x510e527f; ctx->state[5]=0x9b05688c; ctx->state[6]=0x1f83d9ab; ctx->state[7]=0x5be0cd19;
}

__device__ __forceinline__ void sha256_update(sha256_ctx *ctx, const uint8_t data[], size_t len) {
  for (size_t i = 0; i < len; ++i) {
    ctx->data[ctx->datalen++] = data[i];
    if (ctx->datalen == 64) {
      sha256_transform(ctx, ctx->data);
      ctx->bitlen += 512;
      ctx->datalen = 0;
    }
  }
}

__device__ __forceinline__ void sha256_final(sha256_ctx *ctx, uint8_t hash[]) {
  uint32_t i = ctx->datalen;
  ctx->data[i++] = 0x80;
  if (ctx->datalen < 56) {
    while (i < 56) ctx->data[i++] = 0x00;
  } else {
    while (i < 64) ctx->data[i++] = 0x00;
    sha256_transform(ctx, ctx->data);
    for (i = 0; i < 56; ++i) ctx->data[i] = 0;
  }
  ctx->bitlen += ctx->datalen * 8;
  ctx->data[63] = ctx->bitlen;
  ctx->data[62] = ctx->bitlen >> 8;
  ctx->data[61] = ctx->bitlen >> 16;
  ctx->data[60] = ctx->bitlen >> 24;
  ctx->data[59] = ctx->bitlen >> 32;
  ctx->data[58] = ctx->bitlen >> 40;
  ctx->data[57] = ctx->bitlen >> 48;
  ctx->data[56] = ctx->bitlen >> 56;
  sha256_transform(ctx, ctx->data);
  for (i = 0; i < 4; ++i) {
    hash[i]      = (ctx->state[0] >> (24 - i * 8)) & 0xff;
    hash[i + 4]  = (ctx->state[1] >> (24 - i * 8)) & 0xff;
    hash[i + 8]  = (ctx->state[2] >> (24 - i * 8)) & 0xff;
    hash[i + 12] = (ctx->state[3] >> (24 - i * 8)) & 0xff;
    hash[i + 16] = (ctx->state[4] >> (24 - i * 8)) & 0xff;
    hash[i + 20] = (ctx->state[5] >> (24 - i * 8)) & 0xff;
    hash[i + 24] = (ctx->state[6] >> (24 - i * 8)) & 0xff;
    hash[i + 28] = (ctx->state[7] >> (24 - i * 8)) & 0xff;
  }
}

__device__ __forceinline__ int trailing_zero_bits(const uint8_t hash[32]) {
  int bits = 0;
  for (int i = 31; i >= 0; --i) {
    uint8_t b = hash[i];
    if (b == 0) { bits += 8; continue; }
    for (int j = 0; j < 8; ++j) {
      if ((b & (1u << j)) == 0) bits++;
      else return bits;
    }
  }
  return bits;
}

__device__ __forceinline__ void nonce_le(uint64_t nonce, uint8_t out[8]) {
  for (int i = 0; i < 8; ++i) {
    out[i] = (uint8_t)(nonce & 0xffu);
    nonce >>= 8;
  }
}

__host__ __device__ __forceinline__ void set_message_byte(uint32_t words[16], size_t pos, uint8_t value) {
  words[pos >> 2] |= (uint32_t)value << (24 - (int)((pos & 3) * 8));
}

__device__ __forceinline__ void digest_from_state(const uint32_t state[8], uint8_t hash[32]) {
  for (int i = 0; i < 4; ++i) {
    hash[i]      = (state[0] >> (24 - i * 8)) & 0xff;
    hash[i + 4]  = (state[1] >> (24 - i * 8)) & 0xff;
    hash[i + 8]  = (state[2] >> (24 - i * 8)) & 0xff;
    hash[i + 12] = (state[3] >> (24 - i * 8)) & 0xff;
    hash[i + 16] = (state[4] >> (24 - i * 8)) & 0xff;
    hash[i + 20] = (state[5] >> (24 - i * 8)) & 0xff;
    hash[i + 24] = (state[6] >> (24 - i * 8)) & 0xff;
    hash[i + 28] = (state[7] >> (24 - i * 8)) & 0xff;
  }
}

__device__ __forceinline__ bool state_has_trailing_zero_bits(const uint32_t state[8], int difficulty) {
  int remaining = difficulty;
  for (int i = 7; i >= 0 && remaining > 0; --i) {
    if (remaining >= 32) {
      if (state[i] != 0) return false;
      remaining -= 32;
      continue;
    }
    uint32_t mask = (1u << remaining) - 1u;
    return (state[i] & mask) == 0;
  }
  return true;
}

__device__ __forceinline__ bool low_word_has_trailing_zero_bits(uint32_t word, int difficulty) {
  if (difficulty <= 0) return true;
  if (difficulty >= 32) return word == 0;
  return (word & ((1u << difficulty) - 1u)) == 0;
}

__device__ __forceinline__ void sha256_oneblock_state(uint64_t nonce, uint32_t state[8]) {
  uint32_t a,b,c,d,e,f,g,h,t1,t2,w[16];
  #pragma unroll
  for (int i = 0; i < 16; ++i) w[i] = c_base_words[i];

  size_t off = c_nonce_offset;
  #pragma unroll
  for (int i = 0; i < 8; ++i) {
    set_message_byte(w, off + (size_t)i, (uint8_t)(nonce & 0xffu));
    nonce >>= 8;
  }

  a=0x6a09e667; b=0xbb67ae85; c=0x3c6ef372; d=0xa54ff53a;
  e=0x510e527f; f=0x9b05688c; g=0x1f83d9ab; h=0x5be0cd19;
  #pragma unroll 64
  for (int i = 0; i < 64; ++i) {
    uint32_t wi;
    if (i < 16) {
      wi = w[i];
    } else {
      wi = SIG1(w[(i - 2) & 15]) + w[(i - 7) & 15] + SIG0(w[(i - 15) & 15]) + w[i & 15];
      w[i & 15] = wi;
    }
    t1 = h + EP1(e) + CH(e,f,g) + k[i] + wi;
    t2 = EP0(a) + MAJ(a,b,c);
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }

  state[0]=0x6a09e667 + a; state[1]=0xbb67ae85 + b; state[2]=0x3c6ef372 + c; state[3]=0xa54ff53a + d;
  state[4]=0x510e527f + e; state[5]=0x9b05688c + f; state[6]=0x1f83d9ab + g; state[7]=0x5be0cd19 + h;
}

__device__ __forceinline__ uint32_t sha256_oneblock_low_word(uint64_t nonce) {
  uint32_t a,b,c,d,e,f,g,h,t1,t2,w[16];
  #pragma unroll
  for (int i = 0; i < 16; ++i) w[i] = c_base_words[i];

  size_t off = c_nonce_offset;
  #pragma unroll
  for (int i = 0; i < 8; ++i) {
    set_message_byte(w, off + (size_t)i, (uint8_t)(nonce & 0xffu));
    nonce >>= 8;
  }

  a=0x6a09e667; b=0xbb67ae85; c=0x3c6ef372; d=0xa54ff53a;
  e=0x510e527f; f=0x9b05688c; g=0x1f83d9ab; h=0x5be0cd19;
  #pragma unroll 64
  for (int i = 0; i < 64; ++i) {
    uint32_t wi;
    if (i < 16) {
      wi = w[i];
    } else {
      wi = SIG1(w[(i - 2) & 15]) + w[(i - 7) & 15] + SIG0(w[(i - 15) & 15]) + w[i & 15];
      w[i & 15] = wi;
    }
    t1 = h + EP1(e) + CH(e,f,g) + k[i] + wi;
    t2 = EP0(a) + MAJ(a,b,c);
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  return 0x5be0cd19 + h;
}

__global__ void mine_kernel(uint64_t start_nonce, uint64_t batch_size, int difficulty, int *found,
                            uint64_t *solution, uint64_t *found_index, uint8_t *solution_hash) {
  const uint64_t tid = (uint64_t)blockIdx.x * (uint64_t)blockDim.x + (uint64_t)threadIdx.x;
  const uint64_t stride = (uint64_t)gridDim.x * (uint64_t)blockDim.x;

  for (uint64_t idx = tid; idx < batch_size && !*found; idx += stride) {
    uint64_t nonce = start_nonce + idx;
    uint8_t hash[32];
    bool ok = false;

    if (c_prefix_len + 8 <= 55) {
      if (difficulty <= 32) {
        ok = low_word_has_trailing_zero_bits(sha256_oneblock_low_word(nonce), difficulty);
        if (ok) {
          uint32_t state[8];
          sha256_oneblock_state(nonce, state);
          digest_from_state(state, hash);
        }
      } else {
        uint32_t state[8];
        sha256_oneblock_state(nonce, state);
        ok = state_has_trailing_zero_bits(state, difficulty);
        if (ok) digest_from_state(state, hash);
      }
    } else {
      uint8_t nonce_bytes[8];
      nonce_le(nonce, nonce_bytes);
      sha256_ctx ctx;
      sha256_init(&ctx);
      sha256_update(&ctx, c_prefix, c_prefix_len);
      sha256_update(&ctx, nonce_bytes, 8);
      sha256_final(&ctx, hash);
      ok = trailing_zero_bits(hash) >= difficulty;
    }

    if (ok) {
      if (atomicCAS(found, 0, 1) == 0) {
        *solution = nonce;
        *found_index = idx;
        for (int i = 0; i < 32; ++i) solution_hash[i] = hash[i];
      }
      return;
    }
  }
}

__global__ void benchmark_kernel(uint64_t start_nonce, uint64_t batch_size, uint64_t *sink) {
  const uint64_t tid = (uint64_t)blockIdx.x * (uint64_t)blockDim.x + (uint64_t)threadIdx.x;
  const uint64_t stride = (uint64_t)gridDim.x * (uint64_t)blockDim.x;
  uint64_t local = 0;

  for (uint64_t idx = tid; idx < batch_size; idx += stride) {
    local += (uint64_t)sha256_oneblock_low_word(start_nonce + idx);
  }
  atomicAdd((unsigned long long *)&sink[blockIdx.x], (unsigned long long)local);
}

static uint64_t now_ms(void) {
  using namespace std::chrono;
  return (uint64_t)duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static void usage(FILE *out) {
  fprintf(out, "usage: rpow-cuda-miner --prefix HEX --difficulty N [--device N] [--blocks N] [--batch-size N] [--start N] [--cutoff-ms N] [--progress-ms N]\n");
  fprintf(out, "       rpow-cuda-miner --benchmark-ms N --prefix HEX [--device N] [--blocks N] [--batch-size N]\n");
  fprintf(out, "       rpow-cuda-miner --self-test [--device N]\n");
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static int parse_hex(const char *hex, uint8_t *out, size_t *out_len) {
  size_t n = strlen(hex);
  if (n % 2 || n / 2 > 64) return -1;
  for (size_t i = 0; i < n / 2; ++i) {
    int hi = hexval(hex[i * 2]), lo = hexval(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  *out_len = n / 2;
  return 0;
}

static uint64_t parse_u64(const char *s) {
  errno = 0;
  uint64_t v = strtoull(s, NULL, 10);
  if (errno) { fprintf(stderr, "bad integer: %s\n", s); exit(2); }
  return v;
}

static void check_cuda(cudaError_t err, const char *label) {
  if (err != cudaSuccess) {
    fprintf(stderr, "%s: %s\n", label, cudaGetErrorString(err));
    exit(1);
  }
}

int main(int argc, char **argv) {
  uint8_t prefix[64] = {0};
  size_t prefix_len = 0;
  const char *prefix_hex = NULL;
  int difficulty = 0, device = 0;
  uint64_t start_nonce = 0, cutoff_ms = 0, progress_ms = 1000;
  uint64_t batch_size = 1073741824ull;
  uint64_t benchmark_ms = 0;
  int blocks = 0;
  bool self_test = false;

  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--help") || !strcmp(argv[i], "-h")) { usage(stdout); return 0; }
    else if (!strcmp(argv[i], "--self-test")) self_test = true;
    else if (!strcmp(argv[i], "--benchmark-ms") && i + 1 < argc) benchmark_ms = parse_u64(argv[++i]);
    else if (!strcmp(argv[i], "--prefix") && i + 1 < argc) prefix_hex = argv[++i];
    else if (!strcmp(argv[i], "--difficulty") && i + 1 < argc) difficulty = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--device") && i + 1 < argc) device = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--blocks") && i + 1 < argc) blocks = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--batch-size") && i + 1 < argc) batch_size = parse_u64(argv[++i]);
    else if (!strcmp(argv[i], "--start") && i + 1 < argc) start_nonce = parse_u64(argv[++i]);
    else if (!strcmp(argv[i], "--cutoff-ms") && i + 1 < argc) cutoff_ms = parse_u64(argv[++i]);
    else if (!strcmp(argv[i], "--progress-ms") && i + 1 < argc) progress_ms = parse_u64(argv[++i]);
    else { usage(stderr); return 2; }
  }

  if (self_test) {
    prefix_hex = "00";
    difficulty = 8;
    start_nonce = 0;
    batch_size = 1048576ull;
    progress_ms = 0;
  }

  if (!prefix_hex || parse_hex(prefix_hex, prefix, &prefix_len) || (!benchmark_ms && (difficulty <= 0 || difficulty > 256)) || batch_size == 0) {
    usage(stderr);
    return 2;
  }

  uint32_t base_words[16] = {0};
  if (prefix_len + 8 <= 55) {
    for (size_t i = 0; i < prefix_len; ++i) set_message_byte(base_words, i, prefix[i]);
    set_message_byte(base_words, prefix_len + 8, 0x80);
    base_words[15] = (uint32_t)((prefix_len + 8) * 8);
  }

  check_cuda(cudaSetDevice(device), "cudaSetDevice");
  cudaDeviceProp props;
  check_cuda(cudaGetDeviceProperties(&props, device), "cudaGetDeviceProperties");
  if (blocks <= 0) blocks = props.multiProcessorCount * 32;
  if (blocks <= 0) {
    fprintf(stderr, "bad CUDA block count\n");
    return 2;
  }
  check_cuda(cudaMemcpyToSymbol(c_prefix, prefix, prefix_len), "cudaMemcpyToSymbol(prefix)");
  check_cuda(cudaMemcpyToSymbol(c_prefix_len, &prefix_len, sizeof(prefix_len)), "cudaMemcpyToSymbol(prefix_len)");
  check_cuda(cudaMemcpyToSymbol(c_base_words, base_words, sizeof(base_words)), "cudaMemcpyToSymbol(base_words)");
  check_cuda(cudaMemcpyToSymbol(c_nonce_offset, &prefix_len, sizeof(prefix_len)), "cudaMemcpyToSymbol(nonce_offset)");

  int *d_found = NULL;
  uint64_t *d_solution = NULL, *d_found_index = NULL;
  uint8_t *d_solution_hash = NULL;
  uint64_t *d_sink = NULL;
  check_cuda(cudaMalloc((void **)&d_found, sizeof(int)), "cudaMalloc(found)");
  check_cuda(cudaMalloc((void **)&d_solution, sizeof(uint64_t)), "cudaMalloc(solution)");
  check_cuda(cudaMalloc((void **)&d_found_index, sizeof(uint64_t)), "cudaMalloc(found_index)");
  check_cuda(cudaMalloc((void **)&d_solution_hash, 32), "cudaMalloc(solution_hash)");
  check_cuda(cudaMalloc((void **)&d_sink, (size_t)blocks * sizeof(uint64_t)), "cudaMalloc(sink)");

  uint64_t total_hashes = 0, nonce = start_nonce, last_progress = now_ms();
  const int threads = 256;
  if (benchmark_ms) {
    const uint64_t started = now_ms();
    while (now_ms() - started < benchmark_ms) {
      check_cuda(cudaMemset(d_sink, 0, (size_t)blocks * sizeof(uint64_t)), "cudaMemset(sink)");
      benchmark_kernel<<<blocks, threads>>>(nonce, batch_size, d_sink);
      check_cuda(cudaGetLastError(), "benchmark_kernel launch");
      check_cuda(cudaDeviceSynchronize(), "benchmark_kernel");
      nonce += batch_size;
      total_hashes += batch_size;
    }
    const uint64_t elapsed = now_ms() - started;
    double ghps = elapsed ? ((double)total_hashes / ((double)elapsed / 1000.0) / 1000000000.0) : 0.0;
    printf("{\"type\":\"benchmark\",\"hashes\":\"%" PRIu64 "\",\"elapsed_ms\":\"%" PRIu64 "\",\"speed_ghs\":\"%.3f\"}\n", total_hashes, elapsed, ghps);
    fflush(stdout);
    return 0;
  }

  while (true) {
    if (cutoff_ms && now_ms() >= cutoff_ms) {
      printf("{\"type\":\"expired\",\"hashes\":\"%" PRIu64 "\"}\n", total_hashes);
      fflush(stdout);
      return 0;
    }

    int zero = 0;
    check_cuda(cudaMemcpy(d_found, &zero, sizeof(zero), cudaMemcpyHostToDevice), "cudaMemcpy(found)");
    mine_kernel<<<blocks, threads>>>(nonce, batch_size, difficulty, d_found, d_solution, d_found_index, d_solution_hash);
    check_cuda(cudaGetLastError(), "mine_kernel launch");
    check_cuda(cudaDeviceSynchronize(), "mine_kernel");

    int found = 0;
    check_cuda(cudaMemcpy(&found, d_found, sizeof(found), cudaMemcpyDeviceToHost), "cudaMemcpy(found back)");
    if (found) {
      uint64_t solution = 0, found_index = 0;
      uint8_t solution_hash[32];
      check_cuda(cudaMemcpy(&solution, d_solution, sizeof(solution), cudaMemcpyDeviceToHost), "cudaMemcpy(solution)");
      check_cuda(cudaMemcpy(&found_index, d_found_index, sizeof(found_index), cudaMemcpyDeviceToHost), "cudaMemcpy(found_index)");
      check_cuda(cudaMemcpy(solution_hash, d_solution_hash, 32, cudaMemcpyDeviceToHost), "cudaMemcpy(solution_hash)");
      total_hashes += found_index + 1ull;
      printf("{\"type\":\"found\",\"solution_nonce\":\"%" PRIu64 "\",\"hashes\":\"%" PRIu64 "\",\"digest\":\"", solution, total_hashes);
      for (int i = 0; i < 32; ++i) printf("%02x", solution_hash[i]);
      printf("\"}\n");
      fflush(stdout);
      return 0;
    }

    total_hashes += batch_size;
    nonce += batch_size;
    uint64_t now = now_ms();
    if (progress_ms && now - last_progress >= progress_ms) {
      printf("{\"type\":\"progress\",\"hashes\":\"%" PRIu64 "\",\"nonce\":\"%" PRIu64 "\"}\n", total_hashes, nonce);
      fflush(stdout);
      last_progress = now;
    }
  }
}

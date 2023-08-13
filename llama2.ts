// Llama2 transformer model inference in one TypeScript file.
// by Oleksandr Nikitin, 2023 (MIT licensed).
// Based on the Andrej Karpathy's llama2.c: https://github.com/karpathy/llama2.c
//
// Use bun or t348 to run. see params at the end of the file or in the README.
import * as fs from "fs";

// ----------------------------------------------------------------------------
// binary utils

type float = number;
type int = number;
const f32bytes = 4;
const i32bytes = 4;
class BufferReader {
  view: DataView;
  position: number;
  constructor(buffer: Buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.position = 0;
  }

  getInt32LE():int {
    let value = this.view.getInt32(this.position, true);
    this.position += i32bytes;
    return value;
  }

  getFloat32LE():float {
    let value = this.view.getFloat32(this.position, true);
    this.position += f32bytes;
    return value;
  }

  getBytesInto(bytes: Uint8Array) {
    bytes.set(new Uint8Array(this.view.buffer, this.position, bytes.length));
    this.position += bytes.length;
    return bytes;
  }
}



class FileHandleReader {
  handle: number;
  position: number;
  constructor(handle: number, offset: number) {
    this.handle = handle;
    this.position = offset;
  }
  getF32Array(...dims: number[]): Float32Array {
    let totalFloats = dims.reduce((a, b) => a * b);
//    console.log({offset, dims, totalBytes, bb:this.view.buffer.length})
    let bytes = Buffer.alloc(totalFloats * f32bytes);
    fs.readSync(this.handle, bytes, 0, bytes.length, this.position);
    let ret = new Float32Array(bytes.buffer, bytes.byteOffset, totalFloats);
    this.position += totalFloats * f32bytes;
    return ret;
  }

  getF32Arrays(dim0: number, ...dims: number[]): Float32Array[] {
    let array = new Array(dim0);
    for (let i = 0; i < dim0; ++i) {
      array[i] = this.getF32Array(...dims);
    }
    return array;
  }
}
interface Config {
  dim: int;
  hidden_dim: int;
  n_layers: int;
  n_heads: int;
  n_kv_heads: int;
  vocab_size: int;
  seq_len: int;
  shared_weights: boolean;
  head_size: int;
}
function readConfig(buffer: BufferReader):Config {
  let c={} as Config;
  c.dim = buffer.getInt32LE();
  c.hidden_dim = buffer.getInt32LE();
  c.n_layers = buffer.getInt32LE();
  c.n_heads = buffer.getInt32LE();
  c.n_kv_heads = buffer.getInt32LE();
  let vocab_size = buffer.getInt32LE();
  c.vocab_size = Math.abs(vocab_size);
  c.seq_len = buffer.getInt32LE();
  c.shared_weights = vocab_size > 0;
  c.head_size = c.dim / c.n_heads;
  return c;
}

interface TransformerWeights {
  token_embedding_table: Float32Array;
  rms_att_weight: Float32Array[];
  wq: Float32Array[];
  wk: Float32Array[];
  wv: Float32Array[];
  wo: Float32Array[];
  rms_ffn_weight: Float32Array[];
  w1: Float32Array[];
  w2: Float32Array[];
  w3: Float32Array[];
  rms_final_weight: Float32Array;
  freq_cis_real: Float32Array;
  freq_cis_imag: Float32Array;
  wcls: Float32Array;
}

function readWeights(config: Config, buffer: FileHandleReader, shared_weights:boolean):TransformerWeights {
  let w={} as TransformerWeights;
  w.token_embedding_table = buffer.getF32Array(config.vocab_size, config.dim);
  w.rms_att_weight = buffer.getF32Arrays(config.n_layers, config.dim);
  w.wq = buffer.getF32Arrays(config.n_layers, config.dim, config.dim);
  w.wk = buffer.getF32Arrays(config.n_layers, config.dim, config.dim);
  w.wv = buffer.getF32Arrays(config.n_layers, config.dim, config.dim);
  w.wo = buffer.getF32Arrays(config.n_layers, config.dim, config.dim);
  w.rms_ffn_weight = buffer.getF32Arrays(config.n_layers, config.dim); // jagged pointer arithmetic lol
  w.w1 = buffer.getF32Arrays(config.n_layers, config.hidden_dim, config.dim);
  w.w2 = buffer.getF32Arrays(config.n_layers, config.dim, config.hidden_dim);
  w.w3 = buffer.getF32Arrays(config.n_layers, config.hidden_dim, config.dim);
  w.rms_final_weight = buffer.getF32Array(config.dim);
  w.freq_cis_real = buffer.getF32Array(config.seq_len, config.head_size / 2);
  w.freq_cis_imag = buffer.getF32Array(config.seq_len, config.head_size / 2);
  w.wcls = shared_weights ? w.token_embedding_table : buffer.getF32Array(config.vocab_size, config.dim);
  return w;
}

interface RunState {
  // current wave of activations
  x: Float32Array;
  xb: Float32Array;
  xb2: Float32Array;
  hb: Float32Array;
  hb2: Float32Array;
  q: Float32Array;
  k: Float32Array;
  v: Float32Array;
  att: Float32Array; // buffer for scores/attention values (n_heads, seq_len)
  logits: Float32Array;
  key_cache: Float32Array;
  value_cache: Float32Array;
  indices: { prob: float; index: int; }[];
}
function newRunState(config: Config):RunState {
  let s={} as RunState;
  s.indices = new Array(config.vocab_size);
  s.x = new Float32Array(config.dim);
  s.xb = new Float32Array(config.dim);
  s.xb2 = new Float32Array(config.dim);
  s.hb = new Float32Array(config.hidden_dim);
  s.hb2 = new Float32Array(config.hidden_dim);
  s.q = new Float32Array(config.dim);
  s.k = new Float32Array(config.dim);
  s.v = new Float32Array(config.dim);
  s.att = new Float32Array(config.n_heads * config.seq_len);
  s.logits = new Float32Array(config.vocab_size);
  s.key_cache = new Float32Array(config.n_layers * config.seq_len * config.dim);
  s.value_cache = new Float32Array(config.n_layers * config.seq_len * config.dim);
  return s;
}

// ----------------------------------------------------------------------------
// neural net blocks

function accum(a: Float32Array, b: Float32Array, size: number): void {
  for (let i = 0; i < size; i++) {a[i] += b[i];}
}

function rmsnorm(o: Float32Array, x: Float32Array, weight: Float32Array, size: number): void {
  let ss = 0;
  for (let j = 0; j < size; j++) {ss += x[j] * x[j];}
  ss /= size;
  ss = 1.0 / Math.sqrt(1e-5 + ss);
  for (let j = 0; j < size; j++) {o[j] = weight[j] * (ss * x[j]);}
  // debugger;
}

function softmax(x: Float32Array, xPtr: number, size: number): void {
  let max_val = x[xPtr];
  for (let i = 1; i < size; i++) {
    if (x[i + xPtr] > max_val) { max_val = x[i + xPtr];}
  }
  for (let i = 0; i < size; i++) {
    x[i + xPtr] = Math.exp(x[i + xPtr] - max_val);
  }
  let sum = 0;
  for (let i = 0; i < size; i++) {sum += x[i + xPtr];}
  for (let i = 0; i < size; i++) {
    x[i + xPtr] /= sum//Accumulator[0]; // ah forget it, it's numerically stable enough
  }
}

function matmul(xout: Float32Array, x: Float32Array, w: Float32Array, n: number, d: number): void {
  // W (d, n) @ x (n,) -> xout (d,)
  for (let i = 0; i < d; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {sum += w[i * n + j] * x[j];}
    xout[i] = sum//sumAccumulator[0];
  }
}

function transformer(token: number, pos: number, p: Config, s: RunState, w: TransformerWeights): void {
  const x = s.x;
  const dim = p.dim;
  const hidden_dim = p.hidden_dim;
  const head_size = dim / p.n_heads;

  x.set(w.token_embedding_table.subarray(token * dim, token * dim + dim));

  //debugger;
  // forward all the layers
  for (let l = 0; l < p.n_layers; l++) {
    rmsnorm(s.xb, x, w.rms_att_weight[l], dim);

    // qkv matmuls for this position
    matmul(s.q, s.xb, w.wq[l], dim, dim);
    matmul(s.k, s.xb, w.wk[l], dim, dim);
    matmul(s.v, s.xb, w.wv[l], dim, dim);

    // RoPE relative positional encoding: complex-valued rotate q and k by freq_cis in each head
    for (let i = 0; i < dim; i += 2) {
      const q0 = s.q[i];
      const q1 = s.q[i + 1];
      const k0 = s.k[i];
      const k1 = s.k[i + 1];
      const fcr = w.freq_cis_real[pos * head_size / 2 + (i % head_size) / 2];
      const fci = w.freq_cis_imag[pos * head_size / 2 + (i % head_size) / 2];
      s.q[i] = q0 * fcr - q1 * fci;
      s.q[i + 1] = q0 * fci + q1 * fcr;
      s.k[i] = k0 * fcr - k1 * fci;
      s.k[i + 1] = k0 * fci + k1 * fcr;
    }

    // save key,value at this time step (pos) to our kv cache
    const loff = l * p.seq_len * dim; // kv cache layer offset for convenience
    s.key_cache.set(s.k,loff + pos * dim);
    s.value_cache.set(s.v,loff + pos * dim);
    //debugger;

    // multihead attention. iterate over all heads
    for (let h = 0; h < p.n_heads; h++) {
      let q = s.q.subarray(h * head_size, h * head_size + head_size);
      let attPtr= h * p.seq_len;

      // iterate over all timesteps, including the current one
      for (let t = 0; t <= pos; t++) {
        const cached_k = s.key_cache.subarray(loff + t * dim + h * head_size);
        let scope = 0.0;
        for (let i = 0; i < head_size; i++) {scope += q[i] * cached_k[i];}
        s.att[attPtr + t] = scope / Math.sqrt(head_size);
      }

      softmax(s.att, attPtr, pos + 1);
      s.xb.fill(0, h * head_size, h * head_size + head_size)

      // weighted sum of the values, store back into xb
      for (let t = 0; t <= pos; t++) {
        const att_t = s.att[attPtr + t];
        for (let i = 0; i < head_size; i++) {
          s.xb[h * head_size + i] += att_t * s.value_cache[loff + t * dim + h * head_size + i];
        }
      }

    }

    // final matmul to get the output of the attention
    matmul(s.xb2, s.xb, w.wo[l], dim, dim);

    // residual connection back into x
    accum(x, s.xb2, dim);

    // ffn rmsnorm
    rmsnorm(s.xb, x, w.rms_ffn_weight[l], dim);

    // Now for FFN in PyTorch we have: self.w2(F.silu(self.w1(x)) * self.w3(x))
    // first calculate self.w1(x) and self.w3(x)
    matmul(s.hb, s.xb, w.w1[l], dim, hidden_dim);
    matmul(s.hb2, s.xb, w.w3[l], dim, hidden_dim);

    // F.silu; silu(x)=x*σ(x), where σ(x) is the logistic sigmoid
    for (let i = 0; i < hidden_dim; i++) {
      s.hb[i] = s.hb[i] * (1.0 / (1.0 + Math.exp(-s.hb[i])));
    }

    // elementwise multiply with w3(x)
    for (let i = 0; i < hidden_dim; i++) {s.hb[i] = s.hb[i] * s.hb2[i];}

    // final matmul to get the output of the ffn
    matmul(s.xb, s.hb, w.w2[l], hidden_dim, dim);

    // residual connection
    accum(x, s.xb, dim);
  }

  // final rmsnorm
  rmsnorm(x, x, w.rms_final_weight, dim);

  // classifier into logits
  matmul(s.logits, x, w.wcls, p.dim, p.vocab_size);
}

function bpe_encode(text:string, vocab:string[],  vocab_scores:number[],  vocab_size:number,  tokens:Int32Array) {
// first encode every individual byte in the input string
  let n_tokens = 0; // the number of tokens
  for (let i = 0; i < text.length; ++i) {
    let id = vocab.indexOf(text.charAt(i));
    if (id == -1) { throw new Error("Error: character not found in vocab: " + text.charAt(i));}
    tokens[n_tokens++] = id;
  }

  // merge the best consecutive pair each iteration, according the scores in vocab_scores
  while (true) {
    let best_score = -1e10;
    let best_id = -1;
    let best_idx = -1;

    for (let i = 0; i < n_tokens - 1; ++i) {
      // check if we can merge the pair (tokens[i], tokens[i+1])
      let str_buffer = vocab[tokens[i]] + vocab[tokens[i + 1]];
      let id = vocab.indexOf(str_buffer);
      if (id != -1 && vocab_scores[id] > best_score) {
        // this merge pair exists in vocab! record its score and position
        best_score = vocab_scores[id];
        best_id = id;
        best_idx = i;
      }
    }

    if (best_idx == -1) {break;}// we couldn't find any more pairs to merge, so we're done

    // merge the consecutive pair (best_idx, best_idx+1) into new token best_id
    tokens[best_idx] = best_id;
    // delete token at position best_idx+1, shift the entire sequence back 1
    for (let i = best_idx + 1; i < n_tokens - 1; i++) {
      tokens[i] = tokens[i + 1];
    }
    n_tokens--; // token length decreased
  }

  return n_tokens;
}

// ----------------------------------------------------------------------------
// utilities: time / rng
let rng_seed: bigint = 0n;
function random_u32(): number {
  rng_seed ^= (rng_seed >> 12n)
  rng_seed ^= (rng_seed << 25n)&0xffffffffffffffffn;
  rng_seed ^= (rng_seed >> 27n)
  return Number(((rng_seed * 0x2545F4914F6CDD1Dn) >> 32n) & 0xffffffffn);
}

const floatCaster = new Float32Array(1);
function random_f32() { // random float32 in [0,1)
  floatCaster[0]=(random_u32() / 256) / 16777216.0;
  return floatCaster[0]; // force f32
}

// ----------------------------------------------------------------------------
// sampling can be done in a few ways: greedy argmax, sampling, top-p sampling
function argmax(arr: Float32Array): number {
  return arr.reduce((maxIdx, val, idx, array) => (val > array[maxIdx] ? idx : maxIdx), 0);
}

function sample(logits: Float32Array, vocabSize: number): number {
  const sum = logits.reduce((acc, val) => acc + val, 0);
  const randValue = random_f32() * sum;
  let cumProb = 0;
  for (let i = 0; i < vocabSize; i++) {
    cumProb += logits[i]; if (randValue < cumProb) return i;
  }
  return 0;
}

function sample_topp(logits: Float32Array, topp: number, probindex: { index:int,prob:float }[]): number {
  for (let i = 0; i < probindex.length; i++) {probindex[i] = { index: i, prob: logits[i] };}
  probindex.sort((a, b) => b.prob - a.prob);

  let cumProb = 0;
  let lastIdx = 0;
  for (let i = 0; i < probindex.length; i++) {
    cumProb += probindex[i].prob; if (cumProb > topp) {lastIdx = i;break;}
  }

  const randValue = random_f32() * cumProb;
  cumProb = 0;
  for (let i = 0; i < lastIdx; i++) {
    cumProb += probindex[i].prob;if (randValue < cumProb) return probindex[i].index;
  }
  return 0;
}


// ----------------------------------------------------------------------------
// int main
function main(){
  // defaults
  const [_engine,_script,checkpoint,...args] = process.argv;
  let temperature = 1.0; // 0.0 = greedy deterministic. 1.0 = original. don't set higher
  let topp = 1.0;        // top-p in nucleus sampling. 1.0 = off. 0.9 works well, but slower
  rng_seed = 0n;                 // seed rng with time by default
  let steps = 256;       // max number of steps to run for, 0: use seq_len
  let prompt = null;              // prompt string

  if (!checkpoint) {return error_usage();}
  for (let i = 0; i < args.length; i += 2) {
    if (i + 1 >= args.length) { return error_usage(); } // must have arg after flag
    let [arg, val] = [args[i], args[i + 1]];
    if (arg.charAt(0) != '-') { return error_usage(); } // must start with dash
    if (arg.length != 2) { return error_usage(); } // must be -x (one dash, one letter)
    // read in the args
    switch (args[i][1]) {
      case 't': temperature = parseFloat(val);break;
      case 'p': topp = parseFloat(val);break;
      case 's': rng_seed = BigInt(parseInt(val));break;
      case 'n': steps = parseInt(val);break;
      case 'i': prompt = val;break;
      default: return error_usage();
    }
  }
  if (rng_seed == 0n) {rng_seed = BigInt(Date.now());}

  // read in the model.bin file
  let fileHandle = fs.openSync(checkpoint, "r");
  let configSize=  7 * i32bytes;

  // read in the config header
  let configBuffer = Buffer.alloc(configSize);
  fs.readSync(fileHandle, configBuffer, 0, configSize, 0);
  let config = readConfig(new BufferReader(configBuffer));
  //console.error(config);
  let weights = readWeights(config, new FileHandleReader(fileHandle, configSize),config.shared_weights);
  fs.closeSync(fileHandle);

  // right now we cannot run for more than config.seq_len steps
  if (steps <= 0 || steps > config.seq_len) {steps = config.seq_len;}

  // read in the tokenizer.bin file
  let vocab = new Array<string>(config.vocab_size);
  let vocab_scores = new Array<number>(config.vocab_size);
  let tokBuffer = new BufferReader(fs.readFileSync("tokenizer.bin"));
  let ignored_max_token_length = tokBuffer.getInt32LE()
  for (let i = 0; i < config.vocab_size; i++) {
    vocab_scores[i] = tokBuffer.getFloat32LE();
    vocab[i] = new TextDecoder().decode(tokBuffer.getBytesInto(new Uint8Array(tokBuffer.getInt32LE())));
  }
  // create and init the application RunState
  let state = newRunState(config);
  //debugger;
  // process the prompt, if any
  let prompt_tokens:Int32Array = new Int32Array(config.seq_len);
  let num_prompt_tokens = 0;
  if (prompt != null) {
    num_prompt_tokens = bpe_encode(prompt, vocab, vocab_scores, config.vocab_size, prompt_tokens);
  }

  // start the main loop
  let start = 0;  // used to time our code, only initialized after first iteration
  let next;        // will store the next token in the sequence
  let token = 1;   // init with token 1 (=BOS), as done in Llama-2 sentencepiece tokenizer
  let pos = 0;     // position in the sequence
  while (pos < steps) {

    // forward the transformer to get logits for the next token
    transformer(token, pos, config, state, weights);

    // advance the state machine
    if (pos < num_prompt_tokens) {
      // if we are still processing the input prompt, force the next prompt token
      next = prompt_tokens[pos];
    } else {
      // sample the next token
      if (temperature == 0.0) {
        // greedy argmax sampling: take the token with the highest probability
        next = argmax(state.logits);
      } else {
        // apply the temperature to the logits
        for (let q = 0; q < config.vocab_size; q++) {
          state.logits[q] /= temperature;
        }
        // apply softmax to the logits to get the probabilities for next token
        softmax(state.logits, 0, config.vocab_size);
        // we sample from this distribution to get the next token
        if (topp <= 0 || topp >= 1) {
          // simply sample from the predicted probability distribution
          next = sample(state.logits, config.vocab_size);
        } else {
          // top-p (nucleus) sampling, clamping the least likely tokens to zero
          next = sample_topp(state.logits, topp, state.indices);
        }
      }
    }
    pos++;

    // data-dependent terminating condition: the BOS (1) token delimits sequences
    if (next == 1) {break;}

    // following BOS (1) token, sentencepiece decoder strips any leading whitespace (see PR#89)
    let token_str:string = (token == 1 && vocab[next].charAt(0) == ' ') ? vocab[next].substring(1) : vocab[next];
    process.stdout.write(token_str); // note: assumes utf8 terminal
    token = next;

    // init the timer here because the first iteration can be slower
    if (start == 0) start = Date.now();
  }

  // report achieved tok/s (pos-1 because the timer starts after first iteration)
  console.log("\n\nachieved tok/s: %f\n", (pos - 1) / (Date.now() - start) * 1000.0);
}

function error_usage(): never {
  console.error("Usage: ... llama2.ts <checkpoint> [options]");
  console.error("Example: llama2.ts model.bin -n 256 -i \"Once upon a time\"");
  console.error("Options:");
  console.error("  -t <float>  temperature, default 1.0");
  console.error("  -p <float>  p value in top-p (nucleus) sampling. default 0.9, 0 = off");
  console.error("  -s <int>    random seed, default time(NULL)");
  console.error("  -n <int>    number of steps to run for, default 256. 0 = max_seq_len");
  console.error("  -i <string> input prompt");
  process.exit(1);
}

main();

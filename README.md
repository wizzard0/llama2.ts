# llama2.ts
Inference for [Llama2]-like Transformer models in one TypeScript file

Heavily based on the Andrej Karpathy's [llama2.c].

Mostly of educational value (understand something by implementing it yourself! porting in this case but still :P),
as it can't (yet?) load the full Llama2 model (even 7B) due to memory constraints of the JS engines.

### Features
- Binary compatible (i.e. should produce exactly the same outputs as the C version given the parameters and random seed)
- Achieves around 70/25/10 tokens per second for the 15/45/110M models, respectively.

Includes the [TinyStories] 15M model.

### Usage

node (via the bundled [t348]):
```sh
node --experimental-loader=./t348.mjs llama2.ts stories15M.bin -s 1 -t 0 -i "Once upon a time"
```

bun:
```sh
bun llama2.ts stories15M.bin -i "Once upon a time"
```

Larger TinyStories models:
```sh
wget https://huggingface.co/karpathy/tinyllamas/resolve/main/stories42M.bin
wget https://huggingface.co/karpathy/tinyllamas/resolve/main/stories110M.bin
```

Arguments:
- `-i <string>` - initial prompt
- `-t <float>` - temperature (0..1, 0 = deterministic argmax)
- `-s <int>` - random seed
- `-n <int>` - number of tokens to generate (0..256, default 256)
- `-p <float>` - p value for nucleus sampling, default 0.9

[t348]: https://github.com/wizzard0/t348-loader
[TinyStories]: https://arxiv.org/abs/2305.07759
[llama2.c]: https://github.com/karpathy/llama2.c
[Llama2]: https://ai.meta.com/llama/

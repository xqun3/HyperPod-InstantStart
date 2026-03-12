#!/bin/bash

pip3 install -U packaging==23.2 setuptools==75.8.0 wheel ninja
# pip3 install --no-build-isolation axolotl[flash-attn,deepspeed]
cd /opt/ml/code/axolotl && pip3 install --no-build-isolation .[flash-attn,deepspeed]

cd /opt/ml/code
# Download example axolotl configs, deepspeed configs
axolotl fetch examples
axolotl fetch deepspeed_configs  # OPTIONAL


# axolotl train /opt/ml/code/axolotl/examples/llama-3/lora-1b.yml
axolotl train axolotl/examples/llama-3/lora-1b.yml
# axolotl train abc.yml
# axolotl train /opt/ml/code/abc.yml

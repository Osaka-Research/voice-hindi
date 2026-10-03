#!/data/data/com.termux/files/usr/bin/bash
# Test locally downloaded Gemma 4 GGUF variants against real billing prompts,
# for comparison against the live Gemini API results already gathered.
set -u

LLAMA_DIR=~/llama.cpp/llama-b10069
MODEL_DIR=~/models/gemma
THREADS=6
export LD_LIBRARY_PATH="$LLAMA_DIR"

BILLING_PROMPT='You are a billing assistant for a small Indian kirana/grocery shop. The input is a spoken Hindi/Hinglish transcript describing items bought and their prices, e.g. "40 ki maggi 2 50 ka kanda" means: one Maggi at ₹40, and 2 kanda (onion) at ₹50 each. Extract each line item as {product, price, qty}: price = per-unit price in rupees, qty = quantity/count (default 1 if not stated explicitly). Common spoken patterns:
- "<price> ki/ka <product>" → qty=1
- "<qty> <price> ka <product>" or "<product> <qty> <price> ka" → qty units at that price each
Keep product names as spoken, transliterated to simple lowercase Latin (e.g. "kanda", "maggi", "aloo", "tamatar"). If a phrase is unclear or not a billing item, skip it. Return structured JSON matching the schema only.'

JSON_SCHEMA='{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"product":{"type":"string"},"price":{"type":"number"},"qty":{"type":"number"}},"required":["product","price","qty"]}}},"required":["items"]}'

declare -A MODELS=(
  [E2B]="$MODEL_DIR/gemma-4-E2B-it-Q4_0.gguf"
  [E4B]="$MODEL_DIR/gemma-4-E4B-it-Q4_0.gguf"
  [26B-A4B]="$MODEL_DIR/gemma-4-26B_q4_0-it.gguf"
)

TESTS=(
  "40 ki maggi 2 50 ka kanda"
  "चालीस की मैगी बीस की पार्ले"
  "दो हज़ार पांच सौ रुपये का चावल"
  "मुझे बीस रुपये दो"
)

for name in "${!MODELS[@]}"; do
  model="${MODELS[$name]}"
  if [ ! -f "$model" ]; then
    echo "=== $name: model not downloaded yet, skipping ==="
    continue
  fi
  echo "=== $name ($(du -h "$model" | cut -f1)) ==="
  for text in "${TESTS[@]}"; do
    echo "--- input: $text ---"
    start=$(date +%s)
    "$LLAMA_DIR/llama-cli" \
      -m "$model" \
      --no-conversation \
      -t "$THREADS" \
      -n 200 \
      --simple-io \
      --json-schema "$JSON_SCHEMA" \
      -p "$BILLING_PROMPT

Input: $text
Output:" \
      2>/dev/null
    end=$(date +%s)
    echo "(took $((end - start))s)"
    echo
  done
done

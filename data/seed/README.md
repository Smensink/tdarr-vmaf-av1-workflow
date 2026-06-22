# Seed data

These files are aggregate warm-start priors generated from de-identified historical transcode outcomes.

They are intended to reduce cold-start pain, not to replace local learning. Once your own `vmaf_cq_learning.csv` and `ema_cq_state.json` have enough samples, prefer your local data.

Included files:

- `vmaf_cq_priors.seed.json` — aggregate CQ/VMAF/SSIM/CAMBI/BPP/output-ratio summaries by broad bucket
- `ema_cq_state.seed.json` — rounded EMA CQ values by resolution tier

No raw rows are included here. Regenerate from private data with:

```bash
python3 tools/sanitize-learning-data.py \
  --learning-csv /path/to/vmaf_cq_learning.csv \
  --ema-json /path/to/ema_cq_state.json \
  --out-dir data/seed
```

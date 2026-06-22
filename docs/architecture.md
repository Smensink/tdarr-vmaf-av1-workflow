# Architecture

The flow uses Tdarr local plugins communicating through `args.variables`:

1. metadata / preflight checks
2. HDR detection
3. sample extraction
4. CQ sweep encoding
5. VMAF + CAMBI scoring
6. bracket retry if target is not covered
7. best-parameter selection with quality/size guards
8. final AV1 NVENC transcode
9. result export and CQ-learning update

Patched plugins are exported under `plugins/vmaf/`. Runtime Tdarr deployments need those files copied to both local-flow plugin roots used by the server and node.

# Solana GPT Oracle Scheduler (MagicBlock + TukTuk)

Challenge objective completed in this repo:

- Schedule GPT requests with TukTuk.
- Receive callback data from MagicBlock Oracle.
- Persist the latest GPT response on-chain.

## Program Overview

The Anchor program (`solana_gpt_oracle`) stores one PDA state account:

- `oracle_state` (`seed = "oracle_state"`)

`oracle_state` tracks:

- `default_prompt`: prompt text sent to GPT
- `llm_context`: MagicBlock context account used by oracle
- `requests`: number of GPT requests scheduled
- `last_response`: latest callback payload received from GPT
- `treasury_bump`: bump for `treasury` PDA (system-owned payer PDA)
- `task_queue_authority`: authorized signer allowed to run `request_gpt`

### Key Instructions

- `initialize(default_prompt, task_queue_authority)`
  - creates `oracle_state`
  - creates system-owned `treasury` PDA used as oracle CPI payer
  - stores authorized queue authority signer
- `create_context(agent_description)`
  - CPI into `solana-gpt-oracle::create_llm_context`
  - stores resulting `llm_context` in `oracle_state`
- `fund_treasury(lamports)`
  - transfers lamports to treasury PDA for oracle interaction rent
- `schedule(task_id)`
  - compiles and queues a TukTuk task for `request_gpt`
- `request_gpt()`
  - CPI into `solana-gpt-oracle::interact_with_llm`
  - registers callback discriminator for `process_oracle_callback`
- `process_oracle_callback(response)`
  - callback entrypoint invoked by oracle identity signer
  - stores `response` in `oracle_state.last_response`

## External Programs

- MagicBlock Solana GPT Oracle: `LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab`
- TukTuk program (from `@helium/tuktuk-sdk`)

## What Was Changed

- Renamed the program/module flow from counter style to `solana_gpt_oracle` scheduler flow.
- Replaced counter state with oracle scheduler state in `programs/tuktuk-counter/src/state/oracle_state.rs`.
- Added new instructions:
  - `create_context`
  - `fund_treasury`
  - `request_gpt`
  - `process_oracle_callback`
- Updated `schedule` to enqueue `request_gpt` through TukTuk compiled transactions.
- Added signer authorization to `request_gpt` via stored `task_queue_authority`.
- Updated devnet test file: `tests/solana-gpt-oracle.ts`.
- Updated cron script for recurring GPT requests: `cron/cron.ts`.

## Testing Commands (Devnet)

### 1) Environment setup

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=~/.config/solana/id.json
solana config set -u devnet
solana airdrop 2
```

### 2) Build and deploy

```bash
anchor build
anchor deploy
```

### 3) Run setup tests on deployed program

This runs initialize + create_context + fund_treasury against devnet.

```bash
anchor test --skip-local-validator --skip-deploy
```

### 4) Enable scheduling test (TukTuk queue task)

In `tests/solana-gpt-oracle.ts`, change:

```ts
xit("queues a GPT request through TukTuk", async () => {
```

to:

```ts
it("queues a GPT request through TukTuk", async () => {
```

Then run again:

```bash
anchor test --skip-local-validator --skip-deploy
```

### 5) Optional recurring cron test

```bash
anchor run cron
```

Default script (from `Anchor.toml`) uses:

- cron name: `solana-gpt-oracle-cron`
- task queue pubkey: pass with `--taskQueue`

If you see `AccountNotInitialized` for `task_queue_authority` or queue authority init errors,
you are likely not the update authority of that task queue.

Create your own queue (owned by your wallet `BKt4MPhteRZTG4RfMVsbkHhU5anGFmQoJuUsyfUFHG8H`), then pass its pubkey:

```bash
tuktuk --url https://api.devnet.solana.com task-queue create \
  --name my-solana-gpt-oracle \
  --capacity 5 \
  --funding-amount 100000000 \
  --queue-authority BKt4MPhteRZTG4RfMVsbkHhU5anGFmQoJuUsyfUFHG8H \
  --min-crank-reward 1000000 \
  --stale-task-age 0
```

Copy the `Task Queue:` pubkey from the output, then run cron with that queue:

```bash
yarn ts-node cron/cron.ts \
  --cronName solana-gpt-oracle-cron \
  --taskQueue iWJSTmKR47zVuDdswSALrWDBWiawq9b4vwoRmXF24HG
```

Or update `Anchor.toml` and run:

```bash
anchor run cron
```

### 6) Verify response landed on-chain

After scheduling, fetch `oracle_state` and verify:

- `requests` increased
- `lastResponse` is not empty

## Run Flow

1. Build and deploy the Anchor program.
2. Run `initialize` once.
3. Run `create_context` once (uses MagicBlock oracle counter/context seeds).
4. Run `fund_treasury` so the treasury PDA can pay oracle interaction rent.
5. Call `schedule(task_id)` to queue a GPT request via TukTuk.
6. Wait for oracle callback and fetch `oracle_state.last_response`.

## Notes

- `schedule` submits `request_gpt` as a TukTuk compiled transaction.
- The callback is authenticated with the oracle `identity` PDA signer (`seed = "identity"`) from the oracle program.
- `tests/solana-gpt-oracle.ts` includes the end-to-end setup and a skipped (`xit`) scheduling test for manual devnet runs.

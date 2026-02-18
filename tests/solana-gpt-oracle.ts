import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { init, taskKey, taskQueueAuthorityKey } from "@helium/tuktuk-sdk";
import { assert } from "chai";

import { SolanaGptOracle } from "../target/types/solana_gpt_oracle";

const ORACLE_PROGRAM_ID = new anchor.web3.PublicKey(
  "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab"
);

describe("solana-gpt-oracle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solanaGptOracle as Program<SolanaGptOracle>;

  const [oracleState] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_state")],
    program.programId
  );
  const [treasury] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );
  const [queueAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("queue_authority")],
    program.programId
  );
  const [oracleCounter] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("counter")],
    ORACLE_PROGRAM_ID
  );
  const taskQueue = new anchor.web3.PublicKey(
    "CMreFdKxT5oeZhiX8nWTGz9PtXM1AMYTh6dGR2UzdtrA"
  );
  const taskQueueAuthority = taskQueueAuthorityKey(
    taskQueue,
    queueAuthority
  )[0];

  async function deriveLlmContext(): Promise<anchor.web3.PublicKey> {
    const counterInfo = await provider.connection.getAccountInfo(oracleCounter);
    if (!counterInfo) {
      throw new Error("oracle counter PDA is missing");
    }

    const contextCount = counterInfo.data.readUInt32LE(8);
    const countLe = Buffer.alloc(4);
    countLe.writeUInt32LE(contextCount, 0);

    const [llmContext] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("test-context"), countLe],
      ORACLE_PROGRAM_ID
    );
    return llmContext;
  }

  it("initializes local scheduler state", async () => {
    const tx = await program.methods
      .initialize(
        "You are Solana GPT Oracle. Keep responses concise.",
        taskQueueAuthority
      )
      .accountsPartial({
        payer: provider.publicKey,
        oracleState,
        treasury,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    assert.isString(tx);
  });

  it("creates MagicBlock context account", async () => {
    const llmContext = await deriveLlmContext();

    const tx = await program.methods
      .createContext("You are Solana GPT Oracle. Return plain text only.")
      .accountsPartial({
        payer: provider.publicKey,
        oracleState,
        oracleCounter,
        llmContext,
        systemProgram: anchor.web3.SystemProgram.programId,
        oracleProgram: ORACLE_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true });

    assert.isString(tx);
  });

  it("funds treasury PDA for oracle rent", async () => {
    const tx = await program.methods
      .fundTreasury(new anchor.BN(2_000_000))
      .accountsPartial({
        payer: provider.publicKey,
        treasury,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    assert.isString(tx);
  });

  xit("queues a GPT request through TukTuk", async () => {
    const tuktukProgram = await init(provider);
    const state = await program.account.oracleState.fetch(oracleState);

    const [interaction] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("interaction"),
        treasury.toBuffer(),
        state.llmContext.toBuffer(),
      ],
      ORACLE_PROGRAM_ID
    );

    const taskId = 42;

    const tx = await program.methods
      .schedule(taskId)
      .accountsPartial({
        payer: provider.publicKey,
        oracleState,
        treasury,
        llmContext: state.llmContext,
        interaction,
        taskQueue,
        taskQueueAuthority,
        task: taskKey(taskQueue, taskId)[0],
        queueAuthority,
        oracleProgram: ORACLE_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tuktukProgram: tuktukProgram.programId,
      })
      .rpc({ skipPreflight: true });

    assert.isString(tx);
  });
});

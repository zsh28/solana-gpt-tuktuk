import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createCronJob,
  cronJobTransactionKey,
  getCronJobForName,
  init as initCron,
} from "@helium/cron-sdk";
import {
  compileTransaction,
  init,
  taskQueueAuthorityKey,
} from "@helium/tuktuk-sdk";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { sendInstructions } from "@helium/spl-utils";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { SolanaGptOracle } from "../target/types/solana_gpt_oracle";

const ORACLE_PROGRAM_ID = new anchor.web3.PublicKey(
  "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab"
);

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .options({
      cronName: {
        type: "string",
        description: "Cron job name",
        demandOption: true,
      },
      taskQueue: {
        type: "string",
        description: "Task queue public key",
        demandOption: true,
      },
      fundingAmount: {
        type: "number",
        description: "Lamports to fund cron job",
        default: 0.01 * LAMPORTS_PER_SOL,
      },
    })
    .help()
    .alias("help", "h").argv;

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solanaGptOracle as Program<SolanaGptOracle>;
  const tuktukProgram = await init(provider);
  const cronProgram = await initCron(provider);

  const [oracleState] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle_state")],
    program.programId
  );
  const [treasury] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );

  const oracleStateAccount = await program.account.oracleState.fetch(
    oracleState
  );
  if (oracleStateAccount.llmContext.equals(anchor.web3.PublicKey.default)) {
    throw new Error("llm_context not initialized. Run create_context first.");
  }

  const [interaction] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("interaction"),
      treasury.toBuffer(),
      oracleStateAccount.llmContext.toBuffer(),
    ],
    ORACLE_PROGRAM_ID
  );

  const taskQueue = new anchor.web3.PublicKey(argv.taskQueue);
  const [queueAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("queue_authority")],
    program.programId
  );
  const taskQueueAuthority = taskQueueAuthorityKey(
    taskQueue,
    queueAuthority
  )[0];
  const walletTaskQueueAuthority = taskQueueAuthorityKey(
    taskQueue,
    provider.publicKey
  )[0];

  const existingTaskQueueAuthority = await provider.connection.getAccountInfo(
    walletTaskQueueAuthority
  );
  if (!existingTaskQueueAuthority) {
    console.log("Initializing task_queue_authority for wallet authority...");
    try {
      await tuktukProgram.methods
        .addQueueAuthorityV0()
        .accounts({
          payer: provider.publicKey,
          queueAuthority: provider.publicKey,
          taskQueue,
        })
        .rpc({ skipPreflight: true });
    } catch (error) {
      throw new Error(
        `Failed to initialize wallet task_queue_authority for queue ${taskQueue.toBase58()}. ` +
          "You likely are not the queue update authority. Create/use a queue controlled by this wallet."
      );
    }
  }

  const existingCronJob = await getCronJobForName(cronProgram, argv.cronName);
  if (existingCronJob) {
    console.log("Cron job already exists", existingCronJob.toBase58());
    return;
  }

  const {
    pubkeys: { cronJob: cronJobPubkey },
  } = await (
    await createCronJob(cronProgram, {
      tuktukProgram,
      taskQueue,
      args: {
        name: argv.cronName,
        schedule: "0 * * * * *",
        freeTasksPerTransaction: 0,
        numTasksPerQueueCall: 1,
      },
    })
  ).rpcAndKeys({ skipPreflight: false });

  await sendInstructions(provider, [
    SystemProgram.transfer({
      fromPubkey: provider.publicKey,
      toPubkey: cronJobPubkey,
      lamports: argv.fundingAmount,
    }),
  ]);

  const requestInstruction = await program.methods
    .requestGpt()
    .accountsPartial({
      oracleState,
      treasury,
      interaction,
      llmContext: oracleStateAccount.llmContext,
      taskQueueAuthority,
      systemProgram: anchor.web3.SystemProgram.programId,
      oracleProgram: ORACLE_PROGRAM_ID,
    })
    .instruction();

  const { transaction, remainingAccounts } = compileTransaction(
    [requestInstruction],
    []
  );

  await cronProgram.methods
    .addCronTransactionV0({
      index: 0,
      transactionSource: {
        compiledV0: [transaction],
      },
    })
    .accounts({
      payer: provider.publicKey,
      cronJob: cronJobPubkey,
      cronJobTransaction: cronJobTransactionKey(cronJobPubkey, 0)[0],
    })
    .remainingAccounts(remainingAccounts)
    .rpc({ skipPreflight: true });

  console.log("Cron job created", cronJobPubkey.toBase58());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

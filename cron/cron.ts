import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
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
import {
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { sendInstructions } from "@helium/spl-utils";
import { SolanaGptOracle } from "../target/types/solana_gpt_oracle";

const oracleProgram = anchor.workspace
  .solanaGptOracle as Program<SolanaGptOracle>;

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .options({
      cronName: {
        type: "string",
        description: "The name of the cron job to create",
        demandOption: true,
      },
      queueName: {
        type: "string",
        description: "The name of the task queue to use",
        demandOption: true,
      },
      walletPath: {
        type: "string",
        description: "Path to the wallet keypair",
        demandOption: true,
      },
      rpcUrl: {
        type: "string",
        description: "Your Solana RPC URL",
        demandOption: true,
      },
      contextIndex: {
        type: "number",
        description:
          "Index of the context account to interact with (from the counter)",
        default: 0,
      },
      fundingAmount: {
        type: "number",
        description: "Amount of SOL to fund the cron job with (in lamports)",
        default: 0.01 * LAMPORTS_PER_SOL,
      },
    })
    .help()
    .alias("help", "h").argv;

  // Override the provider URL to use the provided RPC URL (Anchor.toml defaults to localnet)
  process.env.ANCHOR_PROVIDER_URL = argv.rpcUrl;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;

  // Derive the context account PDA from the counter index
  const contextAddress = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("test-context"),
      new BN(argv.contextIndex).toArrayLike(Buffer, "le", 4),
    ],
    oracleProgram.programId,
  )[0];

  // Derive the interaction PDA from user + context
  const interactionAddress = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("interaction"),
      wallet.publicKey.toBuffer(),
      contextAddress.toBuffer(),
    ],
    oracleProgram.programId,
  )[0];

  console.log("Using wallet:", wallet.publicKey.toBase58());
  console.log("RPC URL:", argv.rpcUrl);
  console.log("Context index:", argv.contextIndex);
  console.log("Context address:", contextAddress.toBase58());
  console.log("Interaction address:", interactionAddress.toBase58());

  // Initialize TukTuk program
  const program = await init(provider);
  const cronProgram = await initCron(provider);
  const taskQueue = new anchor.web3.PublicKey(
    "EpfZq6c4n1k7qp2UShepRJMGYTbcpJJPL9dmuKn5Q24T",
  );

  // Check if task_queue_authority exists for this wallet, if not create it
  const taskQueueAuthorityPda = taskQueueAuthorityKey(
    taskQueue,
    wallet.publicKey,
  )[0];
  const taskQueueAuthorityInfo = await provider.connection.getAccountInfo(
    taskQueueAuthorityPda,
  );

  if (!taskQueueAuthorityInfo) {
    console.log("Initializing task queue authority for wallet...");
    await program.methods
      .addQueueAuthorityV0()
      .accounts({
        payer: wallet.publicKey,
        queueAuthority: wallet.publicKey,
        taskQueue,
      })
      .rpc({ skipPreflight: true });
    console.log("Task queue authority initialized!");
  } else {
    console.log("Task queue authority already exists");
  }

  // Check if cron job already exists
  let cronJob = await getCronJobForName(cronProgram, argv.cronName);
  console.log("Cron Job:", cronJob);
  if (!cronJob) {
    console.log("Creating new cron job...");
    const {
      pubkeys: { cronJob: cronJobPubkey },
    } = await (
      await createCronJob(cronProgram, {
        tuktukProgram: program,
        taskQueue,
        args: {
          name: argv.cronName,
          schedule: "0 * * * * *", // Run every minute
          // How many "free" tasks to allocate to this cron job per transaction (without paying crank fee)
          freeTasksPerTransaction: 0,
          // We just have one transaction to queue for each cron job, so we set this to 1
          numTasksPerQueueCall: 1,
        },
      })
    ).rpcAndKeys({ skipPreflight: false });
    cronJob = cronJobPubkey;
    console.log(
      "Funding cron job with",
      argv.fundingAmount / LAMPORTS_PER_SOL,
      "SOL",
    );
    await sendInstructions(provider, [
      SystemProgram.transfer({
        fromPubkey: provider.publicKey,
        toPubkey: cronJob,
        lamports: argv.fundingAmount,
      }),
    ]);

    // Build the interact_with_llm instruction
    const callbackDisc = oracleProgram.idl.instructions.find(
      (ix) => ix.name === "callbackFromOracle",
    ).discriminator;

    const interactWithLlmInstruction = new TransactionInstruction({
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: interactionAddress, isSigner: false, isWritable: true }, // interaction
        { pubkey: contextAddress, isSigner: false, isWritable: false }, // context_account
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ],
      data: oracleProgram.coder.instruction.encode("interactWithLlm", {
        text: "Scheduled interaction from TukTuk cron",
        callbackProgramId: oracleProgram.programId,
        callbackDiscriminator: callbackDisc,
        accountMetas: null,
      }),
      programId: oracleProgram.programId,
    });

    // Compile the instruction
    console.log("Compiling instructions...");
    const { transaction, remainingAccounts } = compileTransaction(
      [interactWithLlmInstruction],
      [],
    );

    // Add interact_with_llm transaction to the cron job
    await cronProgram.methods
      .addCronTransactionV0({
        index: 0,
        transactionSource: {
          compiledV0: [transaction],
        },
      })
      .accounts({
        payer: provider.publicKey,
        cronJob,
        cronJobTransaction: cronJobTransactionKey(cronJob, 0)[0],
      })
      .remainingAccounts(remainingAccounts)
      .rpc({ skipPreflight: true });
    console.log(`Cron job created!`);
  } else {
    console.log("Cron job already exists");
  }

  console.log("Cron job address:", cronJob.toBase58());
  console.log(
    `\nYour interact_with_llm instruction will be posted every minute. Watch for transactions on task queue ${taskQueue.toBase58()}. To stop the cron job, use the tuktuk-cli:`,
  );
  console.log(
    `tuktuk -u ${argv.rpcUrl} -w ${argv.walletPath} cron-transaction close --cron-name ${argv.cronName} --id 0`,
  );
  console.log(
    `tuktuk -u ${argv.rpcUrl} -w ${argv.walletPath} cron close --cron-name ${argv.cronName}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

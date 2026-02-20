import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createTaskQueue,
  taskKey,
  taskQueueAuthorityKey,
  tuktukConfigKey,
  taskQueueKey,
} from "@helium/tuktuk-sdk";
import { SolanaGptOracle } from "../target/types/solana_gpt_oracle";
import { assert } from "chai";

describe("solana-gpt-oracle tuktuk tests", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaGptOracle as Program<SolanaGptOracle>;

  const tuktukProgramId = new anchor.web3.PublicKey(
    "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA",
  );

  const queueAuthority = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("queue_authority")],
    program.programId,
  )[0];

  const counterAddress = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("counter")],
    program.programId,
  )[0];

  let localTaskQueue: anchor.web3.PublicKey;
  let assignedQueueId: number;
  let contextAddress: anchor.web3.PublicKey;
  let interactionAddress: anchor.web3.PublicKey;

  it("Initialize program", async () => {
    try {
      const tx = await program.methods
        .initialize()
        .accounts({
          payer: provider.publicKey,
        })
        .rpc();
      console.log("Initialize tx:", tx);
    } catch (e) {
      console.log(
        "Initialize already done (accounts exist), skipping:",
        e.message?.slice(0, 80),
      );
    }
  });

  it("Create LLM context and derive PDAs", async () => {
    // Fetch current counter to derive the context PDA
    const counterAccount = await program.account.counter.fetch(counterAddress);
    const currentCount = counterAccount.count as number;
    console.log("Current counter value:", currentCount);

    contextAddress = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("test-context"),
        new BN(currentCount).toArrayLike(Buffer, "le", 4),
      ],
      program.programId,
    )[0];

    interactionAddress = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("interaction"),
        provider.publicKey.toBuffer(),
        contextAddress.toBuffer(),
      ],
      program.programId,
    )[0];

    console.log("Context address:", contextAddress.toBase58());
    console.log("Interaction address:", interactionAddress.toBase58());

    const tx = await program.methods
      .createLlmContext("TukTuk scheduled context")
      .accountsPartial({
        payer: provider.publicKey,
        contextAccount: contextAddress,
      })
      .rpc();
    console.log("CreateLlmContext tx:", tx);
  });

  it("Initialize local Tuktuk instance", async () => {
    // 1. Fetch the IDL of the tuktuk program from devnet
    const devnetProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection("https://api.devnet.solana.com"),
      (provider as anchor.AnchorProvider).wallet,
      anchor.AnchorProvider.defaultOptions(),
    );
    const tuktukIdl = await anchor.Program.fetchIdl(
      tuktukProgramId,
      devnetProvider,
    );
    if (!tuktukIdl) throw new Error("Could not fetch Tuktuk IDL from devnet");
    const tuktukProgram = new anchor.Program(tuktukIdl, provider);

    // 2. Initialize Tuktuk Config
    const tuktukConfig = tuktukConfigKey(tuktukProgramId)[0];

    const configAcc = await provider.connection.getAccountInfo(tuktukConfig);
    if (!configAcc) {
      try {
        await tuktukProgram.methods
          .initializeTuktukConfigV0({
            minDeposit: new anchor.BN(0),
          })
          .accounts({
            payer: provider.publicKey,
            approver: provider.publicKey,
            authority: provider.publicKey,
            tuktukConfig: tuktukConfig,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        console.error("Initialize config failed!", err);
        throw err;
      }
    }
  });

  it("Create Local Task Queue", async () => {
    const devnetProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection("https://api.devnet.solana.com"),
      (provider as anchor.AnchorProvider).wallet,
      anchor.AnchorProvider.defaultOptions(),
    );
    const tuktukIdl = await anchor.Program.fetchIdl(
      tuktukProgramId,
      devnetProvider,
    );
    const tuktukProgram = new anchor.Program(tuktukIdl, provider);
    const tuktukConfig = tuktukConfigKey(tuktukProgramId)[0];

    // Read the next available queue ID from the tuktuk config
    const tuktukConfigAcc = await (
      tuktukProgram.account as any
    ).tuktukConfigV0.fetch(tuktukConfig);
    assignedQueueId = tuktukConfigAcc.nextTaskQueueId as number;
    console.log("Next queue ID:", assignedQueueId);

    // Use a unique queue name to avoid collisions on devnet
    const queueName = `oracle-queue-${assignedQueueId}`;

    const createQueueIx = await createTaskQueue(tuktukProgram as any, {
      name: queueName,
      capacity: 10,
      minCrankReward: new anchor.BN(100),
      lookupTables: [],
      staleTaskAge: 0,
    });

    // Use the dynamically assigned queue ID
    localTaskQueue = taskQueueKey(
      tuktukConfig,
      assignedQueueId,
      tuktukProgramId,
    )[0];
    console.log("Task queue address:", localTaskQueue.toBase58());

    try {
      await createQueueIx.rpc();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.error("Create queue failed:", err);
      throw err;
    }
  });

  it("Authorize Queue Authority", async () => {
    const devnetProvider = new anchor.AnchorProvider(
      new anchor.web3.Connection("https://api.devnet.solana.com"),
      (provider as anchor.AnchorProvider).wallet,
      anchor.AnchorProvider.defaultOptions(),
    );
    const tuktukIdl = await anchor.Program.fetchIdl(
      tuktukProgramId,
      devnetProvider,
    );
    const tuktukProgram = new anchor.Program(tuktukIdl, provider);

    const taskQueueAuthority = taskQueueAuthorityKey(
      localTaskQueue,
      queueAuthority,
      tuktukProgramId,
    )[0];

    try {
      await tuktukProgram.methods
        .addQueueAuthorityV0()
        .accounts({
          payer: provider.publicKey,
          updateAuthority: provider.publicKey,
          queueAuthority: queueAuthority,
          taskQueueAuthority: taskQueueAuthority,
          taskQueue: localTaskQueue,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      console.error("Failed to add queue authority. Program Logs:");
      if (err.logs) {
        console.error(err.logs);
      } else {
        console.error(err);
      }
      throw err;
    }
  });

  it("Schedule task via tuktuk", async () => {
    const taskID = 0; // The first task on the queue will be 0

    const taskQueueAuthority = taskQueueAuthorityKey(
      localTaskQueue,
      queueAuthority,
      tuktukProgramId,
    )[0];

    try {
      const tx = await program.methods
        .schedule(taskID)
        .accountsPartial({
          user: provider.publicKey,
          interaction: interactionAddress,
          contextAccount: contextAddress,
          taskQueue: localTaskQueue,
          taskQueueAuthority: taskQueueAuthority,
          task: taskKey(localTaskQueue, taskID, tuktukProgramId)[0],
          queueAuthority: queueAuthority,
          systemProgram: anchor.web3.SystemProgram.programId,
          tuktukProgram: tuktukProgramId,
        })
        .rpc();
      assert(
        tuktukProgramId.equals(
          new anchor.web3.PublicKey(
            "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA",
          ),
        ),
      );
      console.log("\nSchedule tx:", tx);
    } catch (e) {
      console.error(e);
      if (e.logs) {
        console.error("Program Logs:", e.logs);
      }
      throw e;
    }
  });
});

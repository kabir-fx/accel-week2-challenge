use std::str::FromStr;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use tuktuk_program::{
    compile_transaction,
    tuktuk::{
        cpi::{accounts::QueueTaskV0, queue_task_v0},
        program::Tuktuk,
        types::TriggerV0,
    },
    types::QueueTaskArgsV0,
    TransactionSourceV0,
};

#[derive(Accounts)]
pub struct Schedule<'info> {
    #[account(
        mut,
        address = Pubkey::from_str("Bm3PBYtPwN17nkSvsogNgk1ycLBgf3BTNpwnrNzZnMRp").unwrap()
    )]
    pub user: Signer<'info>,

    /// CHECK: Interaction PDA — validated by seeds
    #[account(
        mut,
        seeds = [b"interaction", user.key().as_ref(), context_account.key().as_ref()],
        bump
    )]
    pub interaction: AccountInfo<'info>,

    /// CHECK: Context account PDA
    pub context_account: AccountInfo<'info>,

    #[account(mut)]
    /// CHECK: Don't need to parse this account, just using it in CPI
    pub task_queue: UncheckedAccount<'info>,
    /// CHECK: Don't need to parse this account, just using it in CPI
    pub task_queue_authority: UncheckedAccount<'info>,
    /// CHECK: Initialized in CPI
    #[account(mut)]
    pub task: UncheckedAccount<'info>,
    /// CHECK: Via seeds
    #[account(
        mut,
        seeds = [b"queue_authority"],
        bump
    )]
    pub queue_authority: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub tuktuk_program: Program<'info, Tuktuk>,
}

impl<'info> Schedule<'info> {
    pub fn schedule(&mut self, task_id: u16, bumps: ScheduleBumps) -> Result<()> {
        // Build an interact_with_llm instruction to be executed by TukTuk
        let default_text = "Scheduled interaction from TukTuk cron".to_string();

        use anchor_lang::solana_program::hash::hash;
        let interact_disc = &hash(b"global:interact_with_llm").to_bytes()[..8];
        let callback_disc = &hash(b"global:callback_from_oracle").to_bytes()[..8];
        let callback_discriminator: [u8; 8] = callback_disc.try_into().unwrap();

        // Manually serialize the instruction data:
        let mut ix_data = interact_disc.to_vec();
        default_text.serialize(&mut ix_data)?;
        crate::ID.serialize(&mut ix_data)?;
        callback_discriminator.serialize(&mut ix_data)?;
        // None for account_metas (borsh Option::None = single 0 byte)
        0u8.serialize(&mut ix_data)?;

        let (compiled_tx, _) = compile_transaction(
            vec![Instruction {
                program_id: crate::ID,
                accounts: vec![
                    anchor_lang::solana_program::instruction::AccountMeta::new(
                        self.task.key(),
                        true,
                    ), // Task is payer/signer
                    anchor_lang::solana_program::instruction::AccountMeta::new(
                        self.interaction.key(),
                        false,
                    ), // interaction (mut)
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                        self.context_account.key(),
                        false,
                    ), // context_account
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                        self.system_program.key(),
                        false,
                    ), // system_program
                ],
                data: ix_data,
            }],
            vec![],
        )
        .unwrap();

        // Transfer lamports to the task account so it can pay for the interaction account rent
        // Interaction::space for the default text with 0 account metas
        let interaction_space = 121 + default_text.as_bytes().len();
        let rent = Rent::get()?.minimum_balance(interaction_space);
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &self.user.key(),
                &self.task.key(),
                rent,
            ),
            &[
                self.user.to_account_info(),
                self.task.to_account_info(),
                self.system_program.to_account_info(),
            ],
        )?;

        queue_task_v0(
            CpiContext::new_with_signer(
                self.tuktuk_program.to_account_info(),
                QueueTaskV0 {
                    payer: self.user.to_account_info(),
                    queue_authority: self.queue_authority.to_account_info(),
                    task_queue: self.task_queue.to_account_info(),
                    task_queue_authority: self.task_queue_authority.to_account_info(),
                    task: self.task.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                },
                &[&["queue_authority".as_bytes(), &[bumps.queue_authority]]],
            ),
            QueueTaskArgsV0 {
                trigger: TriggerV0::Now,
                transaction: TransactionSourceV0::CompiledV0(compiled_tx),
                crank_reward: Some(1000002),
                free_tasks: 1,
                id: task_id,
                description: "Scheduled LLM interaction".to_string(),
            },
        )?;

        Ok(())
    }
}

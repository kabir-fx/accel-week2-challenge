use anchor_lang::prelude::*;

declare_id!("2qpnJXySMHRbeCKpVC6HGYcr6EGzkKa4hxZVJtbc4qGk");

#[program]
pub mod accel_week2_challenge {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

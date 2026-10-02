// Identity-free fields from a Business account's usage response. Amounts are
// decimal strings, and the endpoint rounds used_percent down to zero.
export const CODEX_BUSINESS_QUOTA = {
  plan_type: 'business',
  rate_limit: null,
  code_review_rate_limit: null,
  additional_rate_limits: null,
  chatpass: { windows: [] },
  credits: { has_credits: true, unlimited: false, balance: null },
  spend_control: {
    reached: false,
    individual_limit: {
      source: 'account_user_spend_controls',
      unit: 'credit',
      limit: '10000',
      used: '2.4138599634170532',
      remaining: '9997.586140036583',
      used_percent: 0,
      remaining_percent: 100,
      reset_after_seconds: 2545084,
      reset_at: 1793491200
    }
  }
}

Shows the state of a Claude agent's prompt cache as a pill in the composer, next to the other pills. The label counts down to the next cachebeat keep-alive, or to the moment the cache lapses when cachebeat is off. Pressing the pill opens a card with the details and a few controls.

The card shows the model, the cache lifetime (1 hour or 5 minutes), the size of the cached context, the time of the last request, whether cachebeat is on and at what interval, the estimated next beat, and what one beat and one cold restart would cost at API list prices. Its buttons send cachebeat's own slash commands to the agent: turn on or off, beat now, set 10, 30 or 50 minutes, and sync exact state.

The plugin reads the agent's Claude Code transcript on the daemon machine. Beats never appear in a transcript, so the next beat and the lapse time are estimates from the last real request. Sync exact state runs `/cachebeat`, which prints cachebeat's real beat count and next beat; the card shows that report with its age.

## Before you use it

The controls on the card drive [cachebeat](https://github.com/404Mayank/cachebeat), a separate Claude Code plugin by someone else. Install it in Claude Code first; its README has the setup steps and the Claude Code version it needs. This plugin does not install it. Without cachebeat the pill still shows the cache lifetime and the time left, but the buttons do nothing useful. Cachebeat is off for each new session until you turn it on, and it starts beating after the session's second turn.

Needs Paseo 0.11.1 or later. The plugin only reads transcripts under the Claude config directory and sends commands when you press a button. Agents that are not Claude agents get no pill. Prices cover API billing, not subscription quota.

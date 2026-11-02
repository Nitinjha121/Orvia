/**
 * The two ways a round ends on purpose. Every other `reason` — the socket
 * closing (`connection_closed`), `session.ended` never arriving
 * (`no_confirmation`), `error: …` from the gateway's teardown, the API shutting
 * down — means the round was cut short, and the end screen must not call it
 * complete. Listed positively so a reason added later reads as cut short until
 * someone decides otherwise.
 */
const INTENDED_ENDS = new Set(['user_ended', 'time_up']);

export function endedCutShort(reason: string | null | undefined): boolean {
  return !INTENDED_ENDS.has(reason ?? '');
}

/** Why it was cut short, in the candidate's terms. */
export function cutShortCause(reason: string): string {
  if (reason === 'connection_closed') return 'The connection to the interview server dropped before the round was ended.';
  if (reason === 'no_confirmation') return 'The interview server never confirmed the round had ended.';
  // `API_SHUTDOWN_REASON` in the gateway; matched on its prefix, which is the stable part.
  if (reason.startsWith('api_shutdown')) return 'The interview server restarted while the round was live.';
  if (reason.startsWith('error')) return 'The interview server hit a problem and ended the round early.';
  return 'The interview server ended the round early.';
}

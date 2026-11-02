/**
 * What to tell the candidate when the microphone cannot be opened, keyed by the
 * `DOMException` name `getUserMedia` rejects with. The raw messages ("Permission
 * denied", "Not supported") were the only feedback before, and none of them
 * says what to do next.
 *
 * Pure, so it takes the error's shape rather than a `DOMException`.
 */
export function micErrorMessage(err: { name?: string; message?: string } | null | undefined): string {
  switch (err?.name) {
    // Also what a dismissed prompt rejects with, so both cases are covered.
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return (
        'The browser did not allow the microphone. If you dismissed the prompt, start again and choose Allow. ' +
        "If it no longer asks, open this site's settings from the icon at the left of the address bar, " +
        'set Microphone to Allow, and start again.'
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one, check it is enabled in your system sound settings, and start again.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return (
        'The microphone is there but could not be opened — another app is probably using it, such as a call ' +
        'or a recorder. Close that app and start again.'
      );
    case 'SecurityError':
    case 'InsecureContextError':
      return 'This page is not allowed to use the microphone because it was not opened securely. Open it over https, or on localhost.';
    default:
      return `The microphone could not be started: ${err?.message || err?.name || 'unknown error'}.`;
  }
}

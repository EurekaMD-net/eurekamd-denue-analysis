/**
 * Full page reload. Its own module so tests can mock it: jsdom's
 * `window.location.reload` is non-configurable and cannot be spied on.
 */
export function reloadPage(): void {
  window.location.reload();
}

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /**
   * Names the panel this boundary guards. With it, a crash costs that panel
   * only and the fallback is inline; without it, the fallback fills the page.
   */
  panel?: string;
};
type State = { error: Error | null };

/**
 * Catches render errors to isolate crashes to individual panels without
 * unmounting surrounding state, offering manual reload options.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Orvia crashed while rendering${this.props.panel ? ` ${this.props.panel}` : ''}:`,
      error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.panel) {
      return (
        <div role="alert" className="rounded-lg border border-danger bg-danger-muted p-4">
          <p className="text-sm font-semibold text-fg">The {this.props.panel} failed to render.</p>
          <p className="mt-1 font-mono text-xs break-words text-fg-subtle">{error.message}</p>
          <button type="button" onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg
                       hover:bg-surface-hover">
            Try again
          </button>
        </div>
      );
    }

    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
        <div className="max-w-md space-y-4 rounded-lg border border-border bg-surface p-6">
          <h1 className="text-lg font-semibold text-fg">Something broke on this screen.</h1>
          <p className="text-sm text-fg-subtle">
            Nothing you have recorded is lost — rounds, recordings and reports live on the
            server, not in this tab.
          </p>
          <p className="font-mono text-xs break-words text-fg-subtle">{error.message}</p>
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

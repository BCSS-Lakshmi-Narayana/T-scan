import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[ErrorBoundary]', this.props.label || 'render error', error, info);
  }

  handleReset = () => {
    this.setState({ error: null, info: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    const stack = err && (err.stack || String(err));
    const componentStack = this.state.info?.componentStack || '';
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-2xl w-full bg-white dark:bg-slate-900 border border-red-200 dark:border-red-800 rounded-2xl shadow-lg p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 flex items-center justify-center shrink-0">
              <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {this.props.label ? `${this.props.label} crashed` : 'Something went wrong'}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                The page hit an unexpected error. Details are below — share them with engineering if it keeps happening.
              </p>
            </div>
          </div>

          <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-3">
            <div className="text-xs font-mono text-red-700 dark:text-red-300 break-words">
              {err?.message || String(err)}
            </div>
          </div>

          <details className="text-[11px] text-gray-500 dark:text-gray-400 mb-4">
            <summary className="cursor-pointer font-medium hover:text-gray-700 dark:hover:text-gray-200">
              Stack trace
            </summary>
            <pre className="mt-2 p-3 bg-gray-50 dark:bg-slate-800 rounded-lg overflow-x-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed max-h-64 overflow-y-auto">
{stack}
{componentStack ? `\n--- Component stack ---${componentStack}` : ''}
            </pre>
          </details>

          <div className="flex gap-2">
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
